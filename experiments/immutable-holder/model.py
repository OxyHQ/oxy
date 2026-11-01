"""Research model only: append-only holders, with simulated hosts and proof."""
from dataclasses import dataclass
from threading import Lock


@dataclass(frozen=True, repr=False)
class Holder:
    # Production IDs must be opaque, high-entropy identifiers, not secrets.
    record_id: str
    device_id: str
    secret: str


class HostUnavailable(Exception):
    pass


class RecordCollision(Exception):
    pass


class CapacityExceeded(Exception):
    pass


class Host:
    """Assumes atomic put-if-absent and durable storage; neither is implemented here."""
    def __init__(self, capacity=10):
        self._records = {}
        self._lock = Lock()
        self.available = True
        self.capacity = capacity

    def add(self, holder):
        with self._lock:
            if not self.available:
                raise HostUnavailable()
            current = self._records.get(holder.record_id)
            if current is not None:
                if current != holder:
                    raise RecordCollision()
                return 'already-present'
            if len(self._records) >= self.capacity:
                raise CapacityExceeded()
            self._records[holder.record_id] = holder
            return 'added'

    def list_ids(self):
        with self._lock:
            if not self.available:
                raise HostUnavailable()
            return frozenset(self._records)

    def authorized_get(self, record_id, *, granted):
        # A boolean is only a fixture. A real host must validate an
        # unforgeable, scoped grant; a caller-supplied boolean is not authority.
        if granted is not True:
            raise PermissionError()
        with self._lock:
            if not self.available:
                raise HostUnavailable()
            return self._records.get(record_id)


class LegacySlot:
    def __init__(self, value=None):
        self.value = value

    def legacy_write(self, holder):
        self.value = holder


def append_all(hosts, holder):
    """Retry the same id after partial failure; never roll back other hosts."""
    if not hosts:
        return 'unsupported'
    results = []
    for host in hosts:
        try:
            results.append(host.add(holder))
        except (HostUnavailable, RecordCollision, CapacityExceeded) as error:
            results.append(type(error).__name__)
    return results


def discover(hosts, *, authorize_listing):
    """A union of sequential reads, not a point-in-time distributed snapshot."""
    if not hosts:
        return 'unsupported', set()
    try:
        if authorize_listing() is not True:
            return 'listing-denied', set()
    except Exception:
        return 'listing-unavailable', set()
    ids = set()
    complete = True
    for host in hosts:
        try:
            snapshot = host.list_ids()
        except HostUnavailable:
            complete = False
            continue
        ids.update(snapshot)
    return ('complete' if complete else 'incomplete'), ids


def import_legacy(hosts, legacy, *, explicitly_requested, verify):
    """Verification is a test fixture; it is not a server or continuous lease."""
    value = legacy.value
    if not explicitly_requested or value is None:
        return 'not-imported'
    if not hosts:
        return 'unsupported'
    try:
        if verify(value) is not True:
            return 'unproven'
    except Exception:
        return 'proof-unavailable'
    return append_all(hosts, value)


def select_explicitly(hosts, record_id, *, authorize_listing, authorize_secret, verify):
    status, ids = discover(hosts, authorize_listing=authorize_listing)
    if status != 'complete':
        return status
    if record_id not in ids:
        return 'not-found'
    try:
        if authorize_secret(record_id) is not True:
            return 'grant-denied'
    except Exception:
        return 'grant-unavailable'
    holder = None
    for host in hosts:
        try:
            value = host.authorized_get(record_id, granted=True)
        except HostUnavailable:
            return 'incomplete'
        if value is not None:
            if holder is not None and value != holder:
                return 'conflict'
            holder = value
    if holder is None:
        return 'not-found'
    try:
        if verify(holder) is not True:
            return 'unproven'
    except Exception:
        return 'proof-unavailable'
    return holder
