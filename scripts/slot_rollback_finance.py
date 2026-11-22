"""Finance-only reversal for the audited 2026-11-22 snapshot (SHA256 6201cde9…643).

Import has no I/O. Call rollback_finance(db) on a trusted sqlite3.Row connection
inside the caller's transaction (prefer BEGIN IMMEDIATE). Never commits. On an
exception the caller should roll back its whole workflow. No CLI or default path.
Does not reset sequences, change risk settings, change total_won, undo experience,
or alter activity unrelated to slot rounds. Fund day/updated_at are metadata,
not a speculative reconstruction of past administrative/clock events.
"""
import hashlib
import json
import sqlite3
from collections import defaultdict
from decimal import Decimal


class FinanceMismatch(ValueError):
    """The snapshot or a ledger relationship differs; do not apply this repair."""


def _require(value, message):
    if not value:
        raise FinanceMismatch(message)


# Ordered logical hashes rather than a filename/file hash (works on SQLite copies
# and inside the caller's transaction). No session, identity or credential data
# is needed. Unrecognised schema, triggers, financial entries or reapplication fail.
_SCHEMA = '8f4c2d9685e3fc44aceb6d42b3f802e21b3d6dc75fa79fc7623319bdab04b40a'
_HASH = {
    'users': '4f9776b73b454b66ee46392022b1f8420176e33cae6af82349960780bd48058c',
    'transactions': 'a68fc678be934ba846cf22840aca9f506dc1cf8f37a80da1e4d6de43c3c665b9',
    'checkins': 'a31968f23b4761829bec54a31ca04fcdc8565b1def49fff0788efcc73051b0f1',
    'slot_fund': '80eb6cd4462f3187d4df24beda109ac3b1af5f016ddc5600451d86bf9a24db27',
    'slot_fund_ledger': '84cb5ee5e8f313668ae7a7b6562761bc8baa8b6f9a78a26687ddf0593fd948bb',
    'video_reward_ledger': 'aa02bd5a45f55b58d7619f14956c99ac9bb77e598f6abf8ac08f42054a36f75a',
    'daily_signins': 'cf631de5049a9c55ddedd013070d9de2d18eaf9df4a2b1565551dcbc748b0b9c',
    'draws': '5a90c0b39ada298d6974c4b91037845e055c122f42215742cceaa74b041e3b1c',
    'video_reward_sessions': 'c140bdc5e549bd5d3d51ba6decec5f33242831d9abc2e4e3e45fd13f2c0e23a7',
}
_EMPTY = ('code_redemptions credit_grant_ledger credit_grants duel_ledger duel_players '
          'duel_rooms duel_events duel_round_results money_transfers peer_loan_ledger '
          'peer_loans usage_logs slot_promotions').split()


def _digest(rows):
    data = json.dumps(list(map(list, rows)), ensure_ascii=True, separators=(',', ':'), allow_nan=False)
    return hashlib.sha256(data.encode('ascii')).hexdigest()


def _units(amount):
    """Use microdollars throughout. Tolerate only tiny binary-REAL residue."""
    raw = Decimal(str(amount)) * 1_000_000
    val = raw.to_integral_value()
    _require(raw.is_finite() and abs(raw - val) < Decimal('0.00001'), 'non-microdollar balance')
    return int(val)


def _plan(db):
    _require(db.row_factory is sqlite3.Row and db.in_transaction,
             'require sqlite3.Row and an existing outer transaction')
    _require(_digest(db.execute('SELECT type,name,tbl_name,sql FROM main.sqlite_schema ORDER BY type,name'))
             == _SCHEMA, 'unexpected main schema')
    _require(not db.execute("SELECT 1 FROM temp.sqlite_schema WHERE type='trigger'").fetchone(),
             'unexpected TEMP trigger')
    for table in _EMPTY:
        _require(not db.execute(f'SELECT 1 FROM main.{table} LIMIT 1').fetchone(),
                 f'unsupported financial dependency: {table}')
    data = {}
    for table, expected in _HASH.items():
        cols = 'id,balance,total_won,has_won' if table == 'users' else '*'
        rows = list(db.execute(f'SELECT {cols} FROM main.{table} ORDER BY id'))
        _require(_digest(rows) == expected, f'not audited snapshot: {table}')
        data[table] = rows

    # transactions lacks a round_id. Only accept the unique matching memberRouter
    # record (including symbol sequence and both monetary legs), never kind alone.
    slot_ids = set()
    txs = data['transactions']
    book = data['slot_fund_ledger']
    seed = book[0]['balance_after_units']
    fund = seed
    for i, r in enumerate(data['checkins']):
        bet, gross = r['bet'], r['gross_payout']
        note = (f"老虎机：下注 ${bet:.2f}，{r['symbols'].replace(',', '/')}，"
                f"返还 ${gross:.2f}（受每日次数限制）")
        matches = [t['id'] for t in txs if t['user_id'] == r['user_id'] and
                   t['kind'] == 'checkin' and t['note'] == note and
                   0 <= t['created_at'] - r['created_at'] <= 4 and
                   _units(t['amount']) == _units(r['delta']) == _units(gross) - _units(bet)]
        _require(len(matches) == 1 and matches[0] not in slot_ids, f"ambiguous round {r['id']}")
        slot_ids.add(matches[0])
        _require(r['fund_before_units'] == fund, 'round opening fund')
        for entry, kind, micro in zip(book[1+2*i:3+2*i], ('bet','payout'), (_units(bet), -_units(gross))):
            _require(micro % 10000 == 0, 'fractional slot cent')
            cents = micro // 10000
            fund += cents
            _require((entry['round_id'], entry['request_id'], entry['type'], entry['amount_units'],
                      entry['balance_after_units']) == (r['id'], r['request_id'], kind, cents, fund),
                     'slot fund ledger mismatch')
        _require(r['fund_after_units'] == fund, 'round closing fund')
    f = data['slot_fund'][0]
    _require((fund, fund-seed) == (f['balance_units'], f['day_net_units']), 'fund does not reconcile')

    # Start from zero (verified by the first recorded balance of every user).
    # Replay original ledger and the counterfactual, in posting order, not just
    # final net. Keep all six decimals, including $0.000001 video rewards.
    old, kept = defaultdict(int), defaultdict(int)
    user_updates, tx_updates, video_updates = [], [], []
    video_matched = set()
    for t in txs:
        uid, tid, amount = t['user_id'], t['id'], _units(t['amount'])
        old[uid] += amount
        _require(old[uid] == _units(t['balance_after']), f'broken ledger at transaction {tid}')
        if tid in slot_ids:
            continue
        kept[uid] += amount
        if kept[uid] != old[uid]:
            tx_updates.append((kept[uid], tid))
        if t['kind'] == 'video_reward':
            matches = [v for v in data['video_reward_ledger'] if v['user_id'] == uid and
                       v['amount_units'] == amount and 0 <= v['created_at']-t['created_at'] <= 2 and
                       _units(v['user_balance_after']) == old[uid]]
            _require(len(matches) == 1 and matches[0]['id'] not in video_matched, 'ambiguous video reward')
            vid = matches[0]['id']
            video_matched.add(vid)
            if kept[uid] != old[uid]:
                video_updates.append((kept[uid], vid))
    _require(len(video_matched) == len(data['video_reward_ledger']), 'orphan video reward')
    for u in data['users']:
        uid = u['id']
        _require(old[uid] == _units(u['balance']) and kept[uid] == _units(u['total_won']),
                 f'user {uid}: independent final balances disagree')
        if kept[uid] != old[uid]:
            user_updates.append((kept[uid], uid))
    _require(sum(kept.values()) - sum(old.values()) == (fund-seed)*10000, 'money not conserved')
    return user_updates, tx_updates, video_updates, sorted(slot_ids), seed


def rollback_finance(db):
    """Stage the audited finance reversal; return counts and integer amounts.

    The caller owns commit/rollback. Rejects a second invocation. Upstream must
    handle any nonfinancial XP/level history in the same outer transaction.
    """
    users, txs, videos, slot_ids, seed = _plan(db)
    db.execute('SAVEPOINT slot_rollback_finance')  # outer transaction required by _plan
    try:
        for table, field, edits in [('users','balance',users), ('transactions','balance_after',txs),
                                    ('video_reward_ledger','user_balance_after',videos)]:
            for micro, row_id in edits:
                cur = db.execute(f'UPDATE main.{table} SET {field}=? WHERE id=?', (micro/1_000_000, row_id))
                _require(cur.rowcount == 1, f'update failed: {table} {row_id}')
        _require(db.executemany('DELETE FROM main.transactions WHERE id=?', [(x,) for x in slot_ids]).rowcount
                 == len(slot_ids), 'transaction delete count')
        _require(db.execute("DELETE FROM main.slot_fund_ledger WHERE type IN ('bet','payout')").rowcount
                 == 2 * len(slot_ids), 'fund delete count')
        _require(db.execute('DELETE FROM main.checkins').rowcount == len(slot_ids), 'round delete count')
        _require(db.execute('UPDATE main.slot_fund SET balance_units=?,day_net_units=0 WHERE id=1',
                            (seed,)).rowcount == 1, 'fund update count')
        result = dict(rounds_deleted=len(slot_ids), transactions_deleted=len(slot_ids),
                      fund_entries_deleted=2*len(slot_ids), fund_balance_cents=seed,
                      users_updated=len(users), transaction_snapshots_updated=len(txs),
                      video_snapshots_updated=len(videos), restored_user_balances_micro={i:v for v,i in users})
    except BaseException:
        if db.in_transaction:
            db.execute('ROLLBACK TO slot_rollback_finance')
            db.execute('RELEASE slot_rollback_finance')
        raise
    db.execute('RELEASE slot_rollback_finance')
    return result
