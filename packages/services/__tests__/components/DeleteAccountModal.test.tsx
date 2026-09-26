/**
 * `DeleteAccountModal` — a failed deletion is shown in Bloom's error Admonition.
 *
 * The error used to render in a hand-rolled box: error-colored text on an
 * error-tinted background, which read as an empty red rectangle
 * (OxyHQ/Mention#1169). Bloom's Admonition draws the message in the theme's
 * text color on its background with an error border, readable in both themes.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import DeleteAccountModal from '../../src/ui/components/modals/DeleteAccountModal';

const t = (key: string, vars?: Record<string, string>) =>
  key === 'deleteAccount.confirmLabel' ? `Type "${vars?.username}" to confirm` : key;

const renderModal = (onDelete: (confirmText: string) => Promise<void>) => {
  const surface = { dismiss: jest.fn() };
  render(
    <DeleteAccountModal
      surface={surface as never}
      username="nate"
      onDelete={onDelete}
      t={t}
    />,
  );
  return surface;
};

const confirmAndDelete = async () => {
  fireEvent.change(screen.getByPlaceholderText('nate'), { target: { value: 'nate' } });
  await act(async () => {
    fireEvent.click(screen.getByText('deleteAccount.confirm').closest('button') as HTMLButtonElement);
  });
};

describe('DeleteAccountModal', () => {
  it('renders no error notice before anything failed', () => {
    renderModal(jest.fn());
    expect(screen.queryByRole('note')).toBeNull();
  });

  it("shows a failed deletion's message in Bloom's error Admonition and stays open", async () => {
    const onDelete = jest.fn(async () => {
      throw new Error('Signature verification failed');
    });
    const surface = renderModal(onDelete);

    await confirmAndDelete();

    expect(onDelete).toHaveBeenCalledWith('nate');
    const notice = screen.getByRole('note');
    expect(notice.getAttribute('data-admonition-type')).toBe('error');
    expect(notice.textContent).toBe('Signature verification failed');
    expect(surface.dismiss).not.toHaveBeenCalled();
  });

  it('dismisses with true once the deletion succeeds', async () => {
    const surface = renderModal(jest.fn(async () => undefined));

    await confirmAndDelete();

    expect(screen.queryByRole('note')).toBeNull();
    expect(surface.dismiss).toHaveBeenCalledWith(true);
  });
});
