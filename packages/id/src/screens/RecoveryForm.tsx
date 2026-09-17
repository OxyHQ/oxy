import { useState } from 'react';
import { parseRecoveryMaterial, type WebIdentityRecoveryMaterial } from '@oxy.so/core';

/**
 * Where a person types their recovery material: a 12- or 24-word phrase, or the
 * private key an older identity was imported with. Parsed here, on this page;
 * nothing typed is sent anywhere. The field is cleared as soon as it is read.
 */
export function RecoveryForm({
  title,
  description,
  submitLabel,
  error,
  onSubmit,
  onBack,
}: {
  title: string;
  description: string;
  submitLabel: string;
  error: string | null;
  onSubmit: (material: WebIdentityRecoveryMaterial) => void;
  onBack: () => void;
}) {
  const [value, setValue] = useState('');
  const [invalid, setInvalid] = useState(false);

  return (
    <section className="card">
      <h1>{title}</h1>
      <p>{description}</p>
      <textarea
        className="phrase-input"
        rows={4}
        autoCapitalize="none"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        aria-label="Recovery phrase"
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          setInvalid(false);
        }}
      />
      {invalid ? <p className="error">That isn’t a valid recovery phrase.</p> : null}
      {error ? <p className="error">{error}</p> : null}
      <div className="actions">
        <button
          type="button"
          className="primary"
          disabled={value.trim().length === 0}
          onClick={() => {
            let material: WebIdentityRecoveryMaterial;
            try {
              material = parseRecoveryMaterial(value);
            } catch {
              setInvalid(true);
              return;
            }
            setValue('');
            onSubmit(material);
          }}
        >
          {submitLabel}
        </button>
        <button type="button" className="link" onClick={onBack}>
          Back
        </button>
      </div>
    </section>
  );
}
