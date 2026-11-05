const { QueryClient } = require('@tanstack/react-query');
const {
  createAccountQueryPersistence,
} = require('../../../packages/services/src/ui/hooks/accountQueryPersistence.ts');
const {
  createPlatformStorage,
} = require('../../../packages/services/src/ui/utils/storageHelpers.ts');
let current;
window.audit = {
  async attach() {
    const storage = await createPlatformStorage();
    const client = new QueryClient();
    const persistence = createAccountQueryPersistence(client, {
      roots: ['saved-searches', 'mailboxes'],
    });
    persistence.setStorage(storage);
    persistence.attach();
    persistence.activate('alice');
    await persistence.whenReady();
    current = { client, persistence };
  },
  set(value) {
    current.client.setQueryData(['saved-searches'], [value]);
  },
  signOut() {
    current.persistence.activate(null);
  },
  detach() {
    current.persistence.detach();
  },
  has() {
    return localStorage.getItem('oxy_account_queries:alice') !== null;
  },
  read() {
    return localStorage.getItem('oxy_account_queries:alice');
  },
};
