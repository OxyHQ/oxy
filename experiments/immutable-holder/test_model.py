import threading
import unittest

from model import (
    CapacityExceeded, Holder, Host, LegacySlot, RecordCollision,
    append_all, discover, import_legacy, select_explicitly,
)


class ImmutableHolderTests(unittest.TestCase):
    def setUp(self):
        self.a = Holder('opaque-a', 'device-a', 'holder-a')
        self.b = Holder('opaque-b', 'device-b', 'holder-b')
        self.valid = lambda holder: holder in (self.a, self.b)

    def discover(self, hosts):
        return discover(hosts, authorize_listing=lambda: True)

    def select(self, hosts, record_id, *, verify):
        return select_explicitly(hosts, record_id, authorize_listing=lambda: True,
                                 authorize_secret=lambda _: True, verify=verify)

    def test_concurrent_distinct_holders_coexist_and_legacy_is_untouched(self):
        hosts = [Host(), Host()]
        legacy = LegacySlot(self.a)
        barrier = threading.Barrier(2)
        results = []
        def writer(value):
            barrier.wait()
            results.append(append_all(hosts, value))
        threads = [threading.Thread(target=writer, args=(value,)) for value in (self.a, self.b)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(results.count(['added', 'added']), 2)
        self.assertEqual(self.discover(hosts)[1], {'opaque-a', 'opaque-b'})
        self.assertEqual(legacy.value, self.a)

    def test_collision_never_replaces_an_existing_record(self):
        host = Host()
        host.add(self.a)
        with self.assertRaises(RecordCollision):
            host.add(Holder(self.a.record_id, 'other-device', 'other-holder'))
        self.assertEqual(host.authorized_get(self.a.record_id, granted=True), self.a)

    def test_partial_append_can_resume_without_rolling_back(self):
        first, second = Host(), Host()
        second.available = False
        self.assertEqual(append_all([first, second], self.a), ['added', 'HostUnavailable'])
        self.assertEqual(self.discover([first, second])[0], 'incomplete')
        second.available = True
        self.assertEqual(append_all([first, second], self.a), ['already-present', 'added'])
        self.assertEqual(self.select([first, second], self.a.record_id, verify=self.valid), self.a)

    def test_later_legacy_write_does_not_mutate_v2_or_implicitly_select(self):
        hosts = [Host(), Host()]
        legacy = LegacySlot(self.a)
        self.assertEqual(import_legacy(hosts, legacy, explicitly_requested=True, verify=self.valid), ['added', 'added'])
        legacy.legacy_write(self.b)
        self.assertEqual(legacy.value, self.b)
        self.assertEqual(self.discover(hosts)[1], {self.a.record_id})
        self.assertEqual(self.select(hosts, self.b.record_id, verify=self.valid), 'not-found')
        self.assertEqual(self.select(hosts, self.a.record_id, verify=self.valid), self.a)

    def test_proof_is_required_at_import_and_again_at_selection(self):
        host = Host()
        legacy = LegacySlot(self.a)
        self.assertEqual(import_legacy([host], legacy, explicitly_requested=False, verify=self.valid), 'not-imported')
        self.assertEqual(import_legacy([host], legacy, explicitly_requested=True, verify=lambda _: False), 'unproven')
        self.assertEqual(import_legacy([host], legacy, explicitly_requested=True, verify=self.valid), ['added'])
        self.assertEqual(self.select([host], self.a.record_id, verify=lambda _: False), 'unproven')

    def test_proof_transport_failure_is_not_absence_or_authorization(self):
        host = Host()
        legacy = LegacySlot(self.a)
        def unavailable(_):
            raise TimeoutError('sensitive fixture message')
        self.assertEqual(import_legacy([host], legacy, explicitly_requested=True, verify=unavailable), 'proof-unavailable')
        self.assertEqual(host.list_ids(), frozenset())
        host.add(self.a)
        self.assertEqual(self.select([host], self.a.record_id, verify=unavailable), 'proof-unavailable')

    def test_unavailable_is_not_empty_and_cannot_trigger_fallback(self):
        first, second = Host(), Host()
        first.add(self.a)
        second.available = False
        self.assertEqual(self.select([first, second], self.a.record_id, verify=self.valid), 'incomplete')
        second.available = True
        self.assertEqual(self.select([first, second], self.a.record_id, verify=self.valid), self.a)

    def test_conflicting_same_ids_across_hosts_are_not_selected(self):
        first, second = Host(), Host()
        first.add(self.a)
        second.add(Holder(self.a.record_id, 'other-device', 'other-holder'))
        self.assertEqual(self.select([first, second], self.a.record_id, verify=lambda _: True), 'conflict')

    def test_capacity_failure_does_not_evict_anyone(self):
        host = Host(capacity=1)
        host.add(self.a)
        with self.assertRaises(CapacityExceeded):
            host.add(self.b)
        self.assertEqual(host.list_ids(), frozenset({self.a.record_id}))
        self.assertEqual(host.authorized_get(self.a.record_id, granted=True), self.a)
        self.assertEqual(host.add(self.a), 'already-present')

    def test_legacy_may_change_during_proof_without_being_overwritten(self):
        host = Host()
        legacy = LegacySlot(self.a)
        def proof(value):
            legacy.legacy_write(self.b)
            return value == self.a
        self.assertEqual(import_legacy([host], legacy, explicitly_requested=True, verify=proof), ['added'])
        self.assertEqual(legacy.value, self.b)
        self.assertEqual(host.authorized_get(self.a.record_id, granted=True), self.a)
        self.assertEqual(self.select([host], self.a.record_id, verify=lambda _: False), 'unproven')

    def test_complete_sequential_discovery_is_not_a_global_snapshot(self):
        first = Host()
        class ConcurrentHost(Host):
            def list_ids(inner):
                first.add(self.a)
                return super().list_ids()
        second = ConcurrentHost()
        status, records = self.discover([first, second])
        self.assertEqual(status, 'complete')
        self.assertEqual(records, set())
        self.assertIn(self.a.record_id, first.list_ids())

    def test_revocation_blocks_future_selection_not_previously_delivered_values(self):
        host = Host()
        host.add(self.a)
        live = True
        delivered = self.select([host], self.a.record_id, verify=lambda _: live)
        live = False
        self.assertEqual(self.select([host], self.a.record_id, verify=lambda _: live), 'unproven')
        self.assertEqual(delivered, self.a)

    def test_legacy_clear_does_not_remove_a_v2_record_in_a_separate_namespace(self):
        host = Host()
        legacy = LegacySlot(self.a)
        self.assertEqual(import_legacy([host], legacy, explicitly_requested=True, verify=self.valid), ['added'])
        legacy.legacy_write(None)
        self.assertIsNone(legacy.value)
        self.assertEqual(host.authorized_get(self.a.record_id, granted=True), self.a)

    def test_no_hosts_is_unsupported_not_successful_empty_storage(self):
        self.assertEqual(self.discover([])[0], 'unsupported')
        self.assertEqual(append_all([], self.a), 'unsupported')
        self.assertEqual(self.select([], self.a.record_id, verify=self.valid), 'unsupported')
        self.assertEqual(import_legacy([], LegacySlot(self.a), explicitly_requested=True, verify=self.valid), 'unsupported')

    def test_discovery_exposes_only_ids_after_listing_authorization(self):
        class TrackingHost(Host):
            def __init__(inner):
                super().__init__()
                inner.list_calls = 0
            def list_ids(inner):
                inner.list_calls += 1
                return super().list_ids()
        host = TrackingHost()
        host.add(self.a)
        self.assertEqual(discover([host], authorize_listing=lambda: False), ('listing-denied', set()))
        self.assertEqual(host.list_calls, 0)
        status, ids = self.discover([host])
        self.assertEqual(status, 'complete')
        self.assertEqual(ids, {self.a.record_id})
        self.assertNotIn(self.a.secret, repr(ids))
        self.assertNotIn(self.a.device_id, repr(ids))

    def test_listing_and_grant_errors_fail_closed_without_secrets(self):
        host = Host()
        host.add(self.a)
        def unavailable(*_):
            raise TimeoutError('sensitive fixture message')
        self.assertEqual(discover([host], authorize_listing=unavailable), ('listing-unavailable', set()))
        self.assertEqual(select_explicitly([host], self.a.record_id, authorize_listing=lambda: True,
                                           authorize_secret=unavailable, verify=self.valid), 'grant-unavailable')

    def test_secret_resolution_needs_a_separate_grant(self):
        class TrackingHost(Host):
            def __init__(inner):
                super().__init__()
                inner.secret_reads = 0
            def authorized_get(inner, record_id, *, granted):
                inner.secret_reads += 1
                return super().authorized_get(record_id, granted=granted)
        host = TrackingHost()
        host.add(self.a)
        denied = select_explicitly([host], self.a.record_id, authorize_listing=lambda: True,
                                   authorize_secret=lambda _: False, verify=self.valid)
        self.assertEqual(denied, 'grant-denied')
        self.assertEqual(host.secret_reads, 0)
        with self.assertRaises(PermissionError):
            host.authorized_get(self.a.record_id, granted=False)


if __name__ == '__main__':
    unittest.main(verbosity=2)
