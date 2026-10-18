"""SQLite owner-fence replay oracle, not cloud object-store lease enforcement."""
import sqlite3,tempfile,unittest
from pathlib import Path
def setup(db):
    db.execute('CREATE TABLE IF NOT EXISTS owner(resource TEXT PRIMARY KEY,epoch INTEGER NOT NULL,holder TEXT NOT NULL)')
    db.execute('CREATE TABLE IF NOT EXISTS effects(resource TEXT,operation TEXT,digest TEXT,PRIMARY KEY(resource,operation))')
    db.commit()
def acquire(db,resource,holder):
    with db:
        row=db.execute('SELECT epoch FROM owner WHERE resource=?',(resource,)).fetchone()
        epoch=(row[0]+1 if row else 1)
        db.execute('INSERT INTO owner VALUES(?,?,?) ON CONFLICT(resource) DO UPDATE SET epoch=excluded.epoch,holder=excluded.holder',(resource,epoch,holder))
        return epoch
def write(db,resource,holder,epoch,operation,digest):
    with db:
        if db.execute('SELECT epoch,holder FROM owner WHERE resource=?',(resource,)).fetchone()!=(epoch,holder):
            raise ValueError('stale_owner')
        old=db.execute('SELECT digest FROM effects WHERE resource=? AND operation=?',(resource,operation)).fetchone()
        if old and old[0]!=digest:raise ValueError('digest_conflict')
        db.execute('INSERT OR IGNORE INTO effects VALUES(?,?,?)',(resource,operation,digest))
class FenceTest(unittest.TestCase):
    def test_stale_owner_cannot_write_after_restart(self):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'fence.db';conn=sqlite3.connect(path);setup(conn)
            old=acquire(conn,'r','a');write(conn,'r','a',old,'e1','a'*64)
            new=acquire(conn,'r','b');conn.close();conn=sqlite3.connect(path)
            with self.assertRaisesRegex(ValueError,'stale_owner'):write(conn,'r','a',old,'e2','b'*64)
            write(conn,'r','b',new,'e2','b'*64)
    def test_conflicting_replay_fails(self):
        conn=sqlite3.connect(':memory:');setup(conn);epoch=acquire(conn,'r','a')
        write(conn,'r','a',epoch,'e','a'*64)
        with self.assertRaisesRegex(ValueError,'digest_conflict'):write(conn,'r','a',epoch,'e','b'*64)
if __name__=='__main__':unittest.main()
