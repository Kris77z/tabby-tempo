"""Deployment order and rollback policy; the adapter owns the fixed VPS I/O."""
from __future__ import annotations

import re

from state_guard import StateError


class DeployError(Exception):
    def __init__(self, code: str, **details):
        self.code = code
        self.details = details
        super().__init__(code)


def error_code(error):
    # Only these trusted exception types carry fixed operator codes. Never
    # persist exception text, repr, a subprocess body, or arbitrary .code fields.
    code = getattr(error, 'code', None)
    if isinstance(error, (DeployError, StateError)) and isinstance(code, str) and re.fullmatch(r'[A-Z][A-Z0-9_]{0,95}', code):
        return code
    return 'DEPLOYMENT_FAILED'


def error_details(error):
    if not isinstance(error, DeployError):
        return {}
    return {key: value for key, value in error.details.items()
            if key in {'originalCode', 'rollbackCode', 'originalPhase', 'rollbackPhase', 'rollbackStopCode'}
            and isinstance(value, str) and re.fullmatch(r'[A-Z][A-Z0-9_]{0,95}', value)}


def execute(adapter, operation: str, sha: str):
    """Never restores private data. An uncertain running state requires an operator."""
    with adapter.lock():
        adapter.validate_request(operation, sha)
        before = adapter.capture()
        adapter.require_quiescent(before)
        candidate = adapter.prepare(operation, sha)
        try:
            adapter.enter_maintenance()
            fresh = adapter.capture()
            adapter.require_quiescent(fresh)
            adapter.compare(before, fresh, 'build')
            adapter.wait_stable()
            stable = adapter.capture()
            adapter.require_quiescent(stable)
            adapter.compare(fresh, stable, 'build')
            fresh = stable
        except Exception:
            adapter.leave_maintenance()
            raise
        stopped = False
        activated = False
        start_attempted = False
        backup = None
        cold = None
        phase = 'STOP'
        try:
            # Set the flag before stop: a partially failed systemctl stop still
            # requires stopping all Upholds-linked units before any recovery.
            stopped = True
            adapter.stop_all()
            phase = 'COLD_CAPTURE'
            cold = adapter.capture()
            adapter.require_quiescent(cold)
            adapter.compare(fresh, cold, 'cold')
            phase = 'BACKUP'
            backup = adapter.backup(cold)
            activated = True
            phase = 'ACTIVATE'
            adapter.activate(candidate)
            phase = 'ACTIVATED_STATE_CHECK'
            adapter.compare(cold, adapter.capture(), 'build')
            start_attempted = True
            phase = 'START'
            adapter.start_all()
            phase = 'HEALTH'
            adapter.health(candidate)
            phase = 'RESTART_STATE_CHECK'
            after = adapter.capture()
            adapter.require_quiescent(after)
            adapter.compare(cold, after, 'restart')
            phase = 'COMMIT'
            result = adapter.commit(candidate, backup, after)
            phase = 'LEAVE_MAINTENANCE'
            adapter.leave_maintenance()
            return result
        except Exception as error:
            if not stopped:
                raise
            details = {'originalCode': error_code(error), 'originalPhase': phase}
            try:
                adapter.stop_all()
                current = adapter.capture()
                adapter.require_quiescent(current)
                if cold is not None:
                    adapter.compare(cold, current, 'restart' if start_attempted else 'build')
                else:
                    adapter.compare(fresh, current, 'cold')
            except Exception as guard_error:
                details.update(rollbackCode=error_code(guard_error), rollbackPhase='ROLLBACK_STATE_CHECK')
                adapter.record_failure('MANUAL_RECONCILIATION_REQUIRED', sha, **details)
                raise DeployError('MANUAL_RECONCILIATION_REQUIRED', **details) from None
            rollback_phase = 'RESTORE_CODE_BUILD'
            try:
                if activated:
                    if backup is None:
                        raise DeployError('BACKUP_NOT_READY')
                    adapter.restore_code_and_build(backup)
                rollback_phase = 'RESET_FAILED'
                adapter.reset_failed()
                rollback_phase = 'START'
                adapter.start_all()
                rollback_phase = 'HEALTH'
                adapter.health_previous()
                rollback_phase = 'RESTART_STATE_CHECK'
                recovered = adapter.capture()
                adapter.require_quiescent(recovered)
                adapter.compare(current, recovered, 'restart')
                rollback_phase = 'RESTORE_CURRENT_RECORD'
                adapter.finish_rollback(backup)
                rollback_phase = 'LEAVE_MAINTENANCE'
                adapter.leave_maintenance()
            except Exception as rollback_error:
                details.update(rollbackCode=error_code(rollback_error), rollbackPhase=rollback_phase)
                code = 'ROLLBACK_FAILED_SERVICES_STOPPED'
                try:
                    adapter.stop_all()
                except Exception as stop_error:
                    # Preserve both earlier failures even when final containment
                    # cannot prove the writers stopped. Never retry the start.
                    details['rollbackStopCode'] = error_code(stop_error)
                    code = 'MANUAL_RECONCILIATION_REQUIRED'
                adapter.record_failure(code, sha, **details)
                raise DeployError(code, **details) from None
            code = error_code(error)
            details.update(rollbackCode='ROLLBACK_SUCCEEDED', rollbackPhase='COMPLETE')
            adapter.record_failure(code, sha, **details)
            raise DeployError(code, **details) from None
