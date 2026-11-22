"""Recompute level rewards for the audited 2026-11-22 slot rollback.

Library only. Call rollback_rewards(db) in the caller's write transaction,
BEFORE changing checkins or transactions. No connection, SQL, or file I/O at
import time. Never opens a database or commits the caller's transaction.
"""

import hashlib
import json
import sqlite3
from collections import Counter
from decimal import Decimal


# Bind to the *business records* of the downloaded snapshot, not its path or
# SQLite page layout. A backup to :memory: or a staged file is equivalent.
_ROUNDS = "id, request_id, user_id, day, created_at, bet, gross_payout, delta, symbols, config_version"
_TX = "id, user_id, kind, amount, note, created_at"
_ROUND_HASH = "50aa2d5843dff20f77f6558f76be7283e8f5bef8360fe4c6fb2263a0a1dff292"
_TX_HASH = "1b1406b6cfc2ddf0c19d8561bb1104cf47b186df4917765bdba515fc5233d9f9"
_SCALE = 1_000_000
# contracts/levels.ts: costs for each transition, then 18,000 per level.
_COSTS = (80, 200, 200, 300, 600, 1000, 1400, 1800, 2400, 3000, 3600, 4200, 5200, 10000, 15000) + (18000,) * 35
_STAGES = {level: sum(_COSTS[:level - 1]) for level in (10, 20, 30, 40, 50)}
_SEATS = "level, rank, user_id, event_id, awarded_at"


def _require(test, msg):
    if not test:
        raise ValueError("slot reward rollback refused: " + msg)


def _digest(rows):
    payload = json.dumps([tuple(r) for r in rows], ensure_ascii=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("ascii")).hexdigest()


def _units(value):
    scaled = Decimal(str(value)) * _SCALE
    _require(scaled.is_finite() and scaled == scaled.to_integral_value(), "non-micro-dollar amount")
    return int(scaled)


def _inputs(db):
    rounds = list(db.execute(f"SELECT {_ROUNDS} FROM main.checkins ORDER BY id"))
    txs = list(db.execute(f"SELECT {_TX} FROM main.transactions ORDER BY id"))
    _require(_digest(rounds) == _ROUND_HASH and _digest(txs) == _TX_HASH,
             "not the audited 76-round / 89-transaction source")
    targets = set()
    for r in rounds:
        note = (f"老虎机：下注 ${r['bet']:.2f}，{r['symbols'].replace(',', '/')}，"
                f"返还 ${r['gross_payout']:.2f}（受每日次数限制）")
        matches = [t['id'] for t in txs if t['kind'] == 'checkin' and t['user_id'] == r['user_id']
                   and t['note'] == note and _units(t['amount']) == _units(r['delta'])
                   and 0 <= t['created_at'] - r['created_at'] <= 1000]
        _require(len(matches) == 1 and matches[0] not in targets, "ambiguous slot settlement")
        targets.add(matches[0])
    inputs = {}
    removed = set()
    signin_receipts = Counter()
    for t in txs:
        uid, tid, kind = t['user_id'], t['id'], t['kind']
        amount = _units(t['amount'])
        if tid not in targets:
            if kind == 'checkin':
                signin_receipts[(uid, t['note'], amount)] += 1
            else:
                _require(kind in ('draw', 'video_reward'), "unknown non-slot transaction")
        if amount > 0:
            key = (uid, f"income:ledger:{tid}")
            inputs[key] = (amount, amount * 100)  # income = 100 EXP/USD, in micro-EXP
            if tid in targets:
                removed.add(key)
    for s in db.execute("SELECT user_id,day,reward_units FROM main.daily_signins"):
        uid, day, cents = tuple(s)
        ref = (uid, f"每日签到（业务日 {day}）", cents * 10_000)
        key = (uid, "signin:" + day)
        _require(signin_receipts[ref] == 1 and key not in inputs, "unmatched daily signin")
        del signin_receipts[ref]
        inputs[key] = (None, 200 * _SCALE)
    _require(not signin_receipts, "missing daily signin source")
    return inputs, removed


def _replay(events, inputs, skip):
    totals, amounts, seats = {}, {}, set()
    ranks = Counter()
    # applyAward allocates first-arrival seats in insertion order; ID breaks
    # same-millisecond ties. This target has no backfill or clock regressions.
    for e in events:
        uid, key = e['user_id'], (e['user_id'], e['event_key'])
        if key in skip:
            continue
        raw = inputs[key][1]
        old = totals.get(uid, 0)
        new = totals[uid] = old + raw
        amounts[e['id']] = new // _SCALE - old // _SCALE
        for level, threshold in _STAGES.items():
            if old < threshold * _SCALE <= new and ranks[level] < 3:
                ranks[level] += 1
                seats.add((level, ranks[level], uid, e['id'], e['created_at']))
    return totals, amounts, seats


def _apply(db):
    _require(not db.execute("SELECT 1 FROM main.sqlite_schema WHERE type='trigger' LIMIT 1").fetchone()
             and not db.execute("SELECT 1 FROM sqlite_temp_schema WHERE type='trigger' LIMIT 1").fetchone(),
             "untested trigger side effects")
    inputs, removed = _inputs(db)
    events = list(db.execute("SELECT id,user_id,event_key,usd_units,amount,created_at FROM main.experience_events ORDER BY id"))
    profiles = {r['user_id']: r for r in db.execute("SELECT * FROM main.level_profiles")}
    keys = [(e['user_id'], e['event_key']) for e in events]
    _require(len(keys) == len(inputs) and set(keys) == set(inputs), "missing, duplicate or unknown experience source")
    _require(all(e['usd_units'] == inputs[k][0] for e, k in zip(events, keys)), "event dollar input differs")
    times = [e['created_at'] for e in events]
    _require(all(isinstance(t, int) and t > 0 for t in times) and times == sorted(times), "unknown dispatch order")
    before, amounts, old_seats = _replay(events, inputs, set())
    _require(all(e['amount'] == amounts[e['id']] for e in events), "pre-existing EXP carry mismatch")
    _require(set(profiles) == set(before) and set(profiles) == {r[0] for r in db.execute('SELECT id FROM main.users')},
             "unexplained profile or opening balance")
    _require(all((p['total_exp'], p['exp_remainder']) == divmod(before[uid], _SCALE) for uid,p in profiles.items()),
             "profile does not match complete award history")
    _require({tuple(r) for r in db.execute(f"SELECT {_SEATS} FROM main.level_badges")} == old_seats,
             "limited badge seats do not match original dispatch")
    ownership = {(row[2], row[0]) for row in old_seats}
    _require(all(p['equipped_level'] is None or (uid,p['equipped_level']) in ownership for uid,p in profiles.items()),
             "equipped badge without proven ownership")

    after, new_amounts, new_seats = _replay(events, inputs, removed)
    # All profiles in this snapshot have retained sources. Do not invent a
    # profile's existence or equipment selection if this condition changes.
    _require(set(after) == set(before), "cannot prove whether empty profile existed")
    for row in old_seats - new_seats:
        db.execute("DELETE FROM main.level_badges WHERE level=? AND rank=?", row[:2])
    db.executemany(f"INSERT INTO main.level_badges ({_SEATS}) VALUES (?,?,?,?,?)", sorted(new_seats - old_seats))
    db.executemany("UPDATE main.experience_events SET amount=? WHERE id=?",
                   [(new_amounts[i], i) for i in new_amounts if amounts[i] != new_amounts[i]])
    db.executemany("DELETE FROM main.experience_events WHERE id=?",
                   [(e['id'],) for e,k in zip(events,keys) if k in removed])
    retained = {(s[2], s[0]) for s in new_seats}
    profile_changes = 0
    for uid, p in profiles.items():
        # The app stores the chosen level (not its rank). Preserve it if the
        # owner still has that level; never auto-equip another user's new seat.
        equip = p['equipped_level'] if (uid, p['equipped_level']) in retained else None
        if after[uid] != before[uid] or equip != p['equipped_level']:
            db.execute("UPDATE main.level_profiles SET total_exp=?,exp_remainder=?,equipped_level=? WHERE user_id=?",
                       (*divmod(after[uid], _SCALE), equip, uid))
            profile_changes += 1
    return {"events_removed": len(removed), "events_retained": len(new_amounts), "profiles_changed": profile_changes,
            "micro_exp_removed": sum(before.values()) - sum(after.values()),
            "badge_seats_removed": len(old_seats - new_seats), "badge_seats_added": len(new_seats - old_seats)}


def rollback_rewards(db):
    """Remove only slot-derived level rewards from this exact business snapshot.

    Requires a sqlite3.Row connection and an active caller-owned transaction.
    A nested savepoint makes refusal atomic even if the caller catches errors.
    Returns diagnostic counts; neither commits nor rolls back the outer work.
    """
    _require(isinstance(db, sqlite3.Connection) and db.row_factory is sqlite3.Row and db.in_transaction,
             "need sqlite3.Connection with sqlite3.Row and an active transaction")
    db.execute("SAVEPOINT slot_rollback_rewards")
    try:
        result = _apply(db)
    except BaseException:
        db.execute("ROLLBACK TO slot_rollback_rewards")
        db.execute("RELEASE slot_rollback_rewards")
        raise
    db.execute("RELEASE slot_rollback_rewards")
    return result
