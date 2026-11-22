"""One-shot reset for the audited offline export. Dry run by default.

python -B scripts/reset_slot_snapshot.py path/to/luckydraw.db [--apply]
Requires a Node version that can import TypeScript using --experimental-strip-types.
Never use this tool to reset a live deployment or an unrelated database.
"""
import argparse
from contextlib import closing
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sqlite3
import subprocess

from slot_rollback_finance import rollback_finance
from slot_rollback_rewards import rollback_rewards

SOURCE_SHA = '6201cde9d650c1ca4bef7ef5f01249240e27eb3a432e45cf7712cd66e5dc9643'
ROOT = Path(__file__).resolve().parents[1]
VERSION = 'daily-slot-v3-3000-b100-1000'


def require(condition, message):
    if not condition:
        raise ValueError(message)


def candidate():
    # Use the actual engine and its validation; do not maintain a second prize table in SQL.
    js = """import { DEFAULT_SLOT_RULES, validateSlotRules, settlementRtpForBet } from './contracts/slot-machine.ts';
      if (DEFAULT_SLOT_RULES.version !== 'daily-slot-v3-3000') throw Error('unexpected engine version');
      const rules = {...DEFAULT_SLOT_RULES, version: 'daily-slot-v3-3000-b100-1000', minBetUnits: 100, maxBetUnits: 1000};
      const metrics = validateSlotRules(rules);
      for(let b=100;b<=1000;b++) if(settlementRtpForBet(rules,b).rtpPpm !== 920000) throw Error('bet-specific RTP');
      console.log(JSON.stringify({rules,metrics}));"""
    data = json.loads(subprocess.check_output(['node', '--experimental-strip-types', '--input-type=module', '-e', js], cwd=ROOT))
    r, m = data['rules'], data['metrics']
    require((r['version'],m['winRatePpm'],m['rtpPpm'],m['maxNetLiabilityUnits']) == (VERSION,300000,920000,99000), 'unexpected new preset')
    return r, m


def integrity(db):
    require([tuple(r) for r in db.execute('PRAGMA integrity_check')] == [('ok',)], 'SQLite integrity check failed')
    require(db.execute('PRAGMA foreign_key_check').fetchone() is None, 'foreign key violation')


def run(db, preset):
    require(db.in_transaction, 'outer transaction required')
    integrity(db)
    active = [tuple(x) for x in db.execute("SELECT id,min_bet_units,max_bet_units FROM slot_configs WHERE status='active' AND mode='base'")]
    require(active == [(8,100,1000)], 'unexpected original configuration')
    rewards = rollback_rewards(db)
    finance = rollback_finance(db)
    require(db.in_transaction, 'unexpected commit')
    rules, m = preset
    db.execute("UPDATE slot_configs SET status='retired' WHERE id=8")
    db.execute("""INSERT INTO slot_configs(version,name,mode,status,rules_json,min_bet_units,max_bet_units,
        win_rate_ppm,rtp_ppm,max_multiplier_basis_points,max_net_liability_units,activated_at)
        VALUES (?,?,'base','active',?,?,?,?,?,?,?,?)""", (rules['version'], rules['name'], json.dumps(rules,ensure_ascii=False,separators=(',',':')),
        rules['minBetUnits'],rules['maxBetUnits'],m['winRatePpm'],m['rtpPpm'],m['maxMultiplierBasisPoints'],m['maxNetLiabilityUnits'],int(datetime.now(timezone.utc).timestamp()*1000)))
    require(db.execute('SELECT COUNT(*) FROM checkins').fetchone()[0]==0,'rounds remain')
    require(tuple(db.execute('SELECT balance_units,day_net_units FROM slot_fund WHERE id=1').fetchone())==(1000000,0),'unbalanced fund')
    require([tuple(r) for r in db.execute('SELECT type,amount_units FROM slot_fund_ledger')]==[('seed',1000000)],'unexpected fund entries')
    require(db.execute("SELECT COUNT(*) FROM slot_configs WHERE mode='base' AND status='active'").fetchone()[0]==1,'multiple active configurations')
    integrity(db)
    return dict(rewards=rewards,finance=finance,active=rules['version'])


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('database',type=Path)
    parser.add_argument('--apply',action='store_true',help='commit to this exact audited offline export after backup')
    args=parser.parse_args()
    path=args.database.resolve(strict=True)
    require(not any(Path(str(path)+s).exists() for s in ('-wal','-shm','-journal')), 'stop the application and export a consistent standalone file first')
    original=path.read_bytes()
    require(hashlib.sha256(original).hexdigest()==SOURCE_SHA,'source has changed or already reset; refusing to write')
    preset=candidate()
    # No filesystem writes during rehearsal, including SQLite sidecars.
    with closing(sqlite3.connect(':memory:')) as test, closing(sqlite3.connect(path.as_uri()+'?mode=ro&immutable=1',uri=True)) as src:
        src.backup(test)
        test.row_factory=sqlite3.Row
        test.execute('PRAGMA foreign_keys=ON')
        test.execute('BEGIN')
        report=run(test,preset)
        test.rollback()
    if args.apply:
        bak=path.with_name(path.name+'.before-slot-reset-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'.bak')
        with closing(sqlite3.connect(path.as_uri()+'?mode=rw',uri=True,timeout=0)) as db:
            db.row_factory=sqlite3.Row
            db.execute('PRAGMA foreign_keys=ON')
            db.execute('PRAGMA synchronous=FULL')
            db.execute('BEGIN IMMEDIATE')
            require(path.read_bytes()==original and not (Path(str(path)+'-wal').exists() and Path(str(path)+'-wal').stat().st_size), 'snapshot changed after rehearsal')
            with bak.open('xb') as f:
                import os
                f.write(original)
                f.flush()
                os.fsync(f.fileno())
            require(hashlib.sha256(bak.read_bytes()).hexdigest()==SOURCE_SHA,'backup hash mismatch')
            applied=run(db,preset)
            require(applied==report,'rehearsal and applied results differ')
            db.commit()
        report.update(backup=str(bak),backup_sha256=SOURCE_SHA)
    print(json.dumps(dict(applied=args.apply,**report),ensure_ascii=True,indent=2))


if __name__=='__main__':
    main()
