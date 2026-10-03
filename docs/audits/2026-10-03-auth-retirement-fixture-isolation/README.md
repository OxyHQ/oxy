Global retirement fixture isolation

CI on f364 showed2 fixture assertions failing beside1591 passing tests. Other suites had populated global agent authority, which the runtime correctly included. This test now owns a normal fully migrated database; all17 cases remain unchanged. The owned-server rehearsal and compiled Node check pass, migrator142/repeat pass, and the server stopped. Production inventory/executor are unchanged. Initial lint failure is preserved; final scoped lint passed. Broader CI and the new native correction remain pending.
