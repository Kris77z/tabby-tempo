import contextlib
import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from transaction import execute, DeployError


class Adapter:
    def __init__(self, fail=None, dirty=None):
        self.events = []
        self.fail = fail
        self.dirty = dirty
        self.captures = 0
        self.maintenance = False
        self.current = 'old'
        self.stopped = False
        self.failed_once = False

    def event(self, value):
        self.events.append(value)
        if self.fail == value and not self.failed_once:
            self.failed_once = True
            raise DeployError('INJECTED_FAILURE')

    @contextlib.contextmanager
    def lock(self):
        self.event('lock')
        yield

    def validate_request(self, *args): self.event('validate')
    def capture(self):
        self.event('capture')
        self.captures += 1
        return {'n': self.captures, 'dirty': self.captures == self.dirty}
    def require_quiescent(self, value):
        self.event('quiescent')
        if value['dirty']: raise DeployError('STATE_HOSTED_INFLIGHT')
    def compare(self, a, b, phase): self.event('compare:' + phase)
    def prepare(self, *args):
        self.event('prepare')
        return {'sha': 'new'}
    def enter_maintenance(self):
        self.event('maintenance-on')
        self.maintenance = True
    def leave_maintenance(self):
        self.event('maintenance-off')
        self.maintenance = False
    def wait_stable(self): self.event('stable')
    def stop_all(self):
        self.event('stop')
        self.stopped = True
    def backup(self, cold):
        self.event('backup')
        return {'sha': 'old'}
    def activate(self, candidate):
        self.current = 'new'
        self.event('activate')
    def start_all(self):
        self.event('start')
        self.stopped = False
    def health(self, candidate): self.event('health-new')
    def commit(self, *args):
        self.event('commit')
        return {'released': 'new'}
    def restore_code_and_build(self, backup):
        self.event('restore-code-build')
        self.current = 'old'
    def health_previous(self): self.event('health-old')
    def finish_rollback(self, backup): self.event('restore-current-record')
    def record_failure(self, code, sha): self.event('failure:' + code)


class TransactionTest(unittest.TestCase):
    def test_success_drain_before_stop_and_cold_before_activate(self):
        a = Adapter()
        self.assertEqual(execute(a, 'release', 'a' * 40), {'released': 'new'})
        self.assertLess(a.events.index('maintenance-on'), a.events.index('stop'))
        self.assertLess(a.events.index('stable'), a.events.index('stop'))
        self.assertLess(a.events.index('backup'), a.events.index('activate'))
        self.assertFalse(a.maintenance)
        self.assertFalse(a.stopped)

    def test_initial_busy_refused_without_maintenance_or_stop(self):
        a = Adapter(dirty=1)
        with self.assertRaises(DeployError): execute(a, 'release', 'a' * 40)
        self.assertNotIn('prepare', a.events)
        self.assertNotIn('stop', a.events)

    def test_new_request_during_ingress_drain_refused_without_stop(self):
        for dirty in [2, 3]:
            a = Adapter(dirty=dirty)
            with self.assertRaises(DeployError): execute(a, 'release', 'a' * 40)
            self.assertNotIn('stop', a.events)
            self.assertFalse(a.maintenance)

    def test_build_failure_never_enters_maintenance(self):
        a = Adapter(fail='prepare')
        with self.assertRaises(DeployError): execute(a, 'release', 'a' * 40)
        self.assertNotIn('maintenance-on', a.events)
        self.assertNotIn('stop', a.events)

    def test_partial_stop_backup_and_activation_failure_recover(self):
        for failure in ['stop', 'backup', 'activate', 'start', 'health-new', 'commit']:
            with self.subTest(failure=failure):
                a = Adapter(fail=failure)
                with self.assertRaises(DeployError) as error: execute(a, 'release', 'a' * 40)
                self.assertEqual(error.exception.code, 'INJECTED_FAILURE')
                self.assertFalse(a.maintenance)
                self.assertFalse(a.stopped)
                self.assertIn('health-old', a.events)
                self.assertIn('restore-current-record', a.events)
                if failure in ['activate', 'start', 'health-new', 'commit']:
                    self.assertEqual(a.current, 'old')

    def test_after_start_business_dirty_keeps_new_code_stopped_and_journal(self):
        a = Adapter(fail='health-new', dirty=6)
        with self.assertRaises(DeployError) as error: execute(a, 'release', 'a' * 40)
        self.assertEqual(error.exception.code, 'MANUAL_RECONCILIATION_REQUIRED')
        self.assertTrue(a.maintenance)
        self.assertTrue(a.stopped)
        self.assertEqual(a.current, 'new')
        self.assertNotIn('restore-code-build', a.events)

    def test_rollback_failure_stops_all_and_preserves_maintenance(self):
        class BrokenRestore(Adapter):
            def restore_code_and_build(self, backup): raise OSError('injected')
        a = BrokenRestore(fail='health-new')
        with self.assertRaises(DeployError) as error: execute(a, 'release', 'a' * 40)
        self.assertEqual(error.exception.code, 'ROLLBACK_FAILED_SERVICES_STOPPED')
        self.assertTrue(a.maintenance)
        self.assertTrue(a.stopped)

    def test_worker_termination_uses_same_safe_rollback(self):
        class Cancelled(Adapter):
            def health(self, candidate): raise DeployError('DEPLOY_CANCELLED')
        a = Cancelled()
        with self.assertRaises(DeployError) as error: execute(a, 'release', 'a' * 40)
        self.assertEqual(error.exception.code, 'DEPLOY_CANCELLED')
        self.assertEqual(a.current, 'old')
        self.assertFalse(a.maintenance)


if __name__ == '__main__': unittest.main()
