import ca from '../locales/ca-ES';
import en from '../locales/en-US';
import es from '../locales/es-ES';

test('sign-in explains one Oxy account, and names the host app when the dialog knows it', () => {
  expect(en.signin.oneAccount).toBe('One Oxy account works across Oxy apps');
  expect(en.signin.oneAccountInApp).toBe('One Oxy account works across {{app}} and other Oxy apps');
  expect(es.signin.oneAccountInApp).toBe(
    'Con una cuenta de Oxy entras en {{app}} y en el resto de apps de Oxy',
  );
  expect(ca.signin.oneAccountInApp).toBe(
    "Amb un compte d'Oxy entres a {{app}} i a la resta d'apps d'Oxy",
  );
});

test('signup says whether a username is free, in English, Spanish and Catalan', () => {
  expect(en.signup.username.available).toBe('This username is available.');
  expect(en.signup.username.taken).toBe('That username is taken.');
  expect(es.signup.username.available).toBe('Este nombre de usuario está disponible.');
  expect(es.signup.username.taken).toBe('Ese nombre de usuario ya está en uso.');
  expect(ca.signup.username.available).toBe("Aquest nom d'usuari està disponible.");
  expect(ca.signup.username.taken).toBe("Aquest nom d'usuari ja està agafat.");
});
