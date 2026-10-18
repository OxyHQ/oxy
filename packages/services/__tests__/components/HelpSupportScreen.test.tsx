import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Linking } from 'react-native';
import { toast } from '@oxy.so/bloom/toast';
import HelpSupportScreen from '../../src/ui/screens/HelpSupportScreen';
import ReportBugScreen from '../../src/ui/screens/ReportBugScreen';
import { OxySupportContext } from '../../src/ui/context/oxySupportContext';

jest.mock('../../src/ui/hooks/useI18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
jest.mock('../../src/ui/hooks/useSurfaceHeader', () => ({ useSurfaceHeader: () => undefined }));
beforeEach(() => jest.clearAllMocks());

test('opens host Alia without dismissing Oxy and routes bug reports within the dialog', () => {
  const calls: string[] = [];
  const navigate = jest.fn();
  render(
    <OxySupportContext.Provider
      value={{
        onAskAlia: () => {
          calls.push('alia');
        },
      }}
    >
      <HelpSupportScreen onClose={() => calls.push('close')} navigate={navigate} />
    </OxySupportContext.Provider>,
  );
  fireEvent.click(screen.getByText('help.alia.title'));
  expect(calls).toEqual(['alia']);
  expect(screen.getByText('help.alia.title')).toBeTruthy();
  expect(screen.queryByText('help.contact.title')).toBeNull();
  fireEvent.click(screen.getByText('help.reportBug.title'));
  expect(navigate).toHaveBeenCalledWith('ReportBug');
});

test('opens the requested developer and community destinations', () => {
  const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
  render(<HelpSupportScreen />);
  fireEvent.click(screen.getByText('help.developersPortal.title'));
  expect(openURL).toHaveBeenCalledWith('https://oxy.so/developers/');
  fireEvent.click(screen.getByText('help.documentation.title'));
  expect(openURL).toHaveBeenCalledWith('https://oxy.so/developers/docs/');
  fireEvent.click(screen.getByText('help.community.title'));
  expect(openURL).toHaveBeenCalledWith('https://t.me/OxyHQInc');
});

test('validates bug report fields and encodes a draft without claiming it was sent', async () => {
  const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
  render(<ReportBugScreen />);
  fireEvent.click(screen.getByRole('button', { name: 'help.reportBug.continueEmail' }));
  expect(screen.getAllByRole('alert')).toHaveLength(2);
  expect(openURL).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole('textbox', { name: 'help.reportBug.summary' }), {
    target: { value: 'Header & title?' },
  });
  fireEvent.change(screen.getByRole('textbox', { name: 'help.reportBug.description' }), {
    target: { value: 'First line\nSecond & third' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'help.reportBug.continueEmail' }));
  await waitFor(() =>
    expect(openURL).toHaveBeenCalledWith(
      'mailto:bugs@oxy.so?subject=Header%20%26%20title%3F&body=First%20line%0ASecond%20%26%20third',
    ),
  );
  expect(toast.success).not.toHaveBeenCalled();
});

test('keeps report text and shows a toast if the mail app cannot open', async () => {
  jest.spyOn(Linking, 'openURL').mockRejectedValue(new Error('Unavailable'));
  render(<ReportBugScreen />);
  fireEvent.change(screen.getByRole('textbox', { name: 'help.reportBug.summary' }), {
    target: { value: 'Title' },
  });
  fireEvent.change(screen.getByRole('textbox', { name: 'help.reportBug.description' }), {
    target: { value: 'Details' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'help.reportBug.continueEmail' }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('help.reportError'));
  expect(
    (screen.getByRole('textbox', { name: 'help.reportBug.description' }) as HTMLTextAreaElement)
      .value,
  ).toBe('Details');
});

test('uses host documentation and avatar', () => {
  const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
  render(
    <OxySupportContext.Provider
      value={{
        documentationUrl: 'https://oxy.so/developers/docs/mention/',
        onAskAlia: () => {},
        aliaAvatar: <span>Alia portrait</span>,
      }}
    >
      <HelpSupportScreen />
    </OxySupportContext.Provider>,
  );
  fireEvent.click(screen.getByText('help.documentation.title'));
  expect(openURL).toHaveBeenCalledWith('https://oxy.so/developers/docs/mention/');
  expect(screen.getByText('Alia portrait')).toBeTruthy();
});
