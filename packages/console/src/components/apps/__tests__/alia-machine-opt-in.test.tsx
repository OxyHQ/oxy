// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GeneralSection } from '../general-section'
import type { Application, CallerAccess } from '@/hooks/use-applications'
import { mergeAliaMachineScopes } from '@/lib/application-scopes'

const update = vi.hoisted(() => vi.fn())
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
vi.mock('@oxy.so/services', () => ({ useAuth: () => ({ oxyServices: {} }) }))
vi.mock('@oxy.so/bloom/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/hooks/use-applications', () => ({
  useUpdateApplication: () => ({ mutateAsync: update, isPending: false }),
  useDeleteApplication: () => ({ mutateAsync: vi.fn(), isPending: false }),
}))
vi.mock('@/components/ui/image-upload-field', () => ({ ImageUploadField: () => null }))
const application: Application = {
  _id: 'app', name: 'Caller', ownerAccountId: 'owner', createdByUserId: 'owner',
  type: 'third_party', status: 'active', isOfficial: false, isInternal: false,
  capabilities: [], redirectUris: [], scopes: ['user:read'],
  createdAt: '2026-10-04T00:00:00Z', updatedAt: '2026-10-04T00:00:00Z',
}
function mount(scopes = application.scopes, canEdit = true) {
  const access: CallerAccess = { membership: undefined, role: undefined, isResolved: true,
    can: permission => permission === 'app:update' && canEdit }
  render(<GeneralSection application={{ ...application, scopes }} access={access} />)
  return screen.getByRole('switch', { name: 'Alia chat and inference' })
}
afterEach(cleanup)
beforeEach(() => { update.mockReset(); update.mockResolvedValue({}) })
describe('explicit Console Alia capability opt-in', () => {
  it('does not grant capabilities by default', () => {
    expect(mount().getAttribute('aria-checked')).toBe('false')
    expect(update).not.toHaveBeenCalled()
  })
  it('saves the explicit pair without dropping other capabilities', async () => {
    fireEvent.click(mount(['user:read', 'payments:read']))
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(update).toHaveBeenCalledOnce())
    expect(update.mock.calls[0][0].data.scopes).toEqual(['user:read', 'payments:read', 'alia:chat', 'inference:invoke'])
  })
  it('removes the explicit pair without changing other capabilities', async () => {
    fireEvent.click(mount(['user:read', 'alia:chat', 'inference:invoke']))
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(update).toHaveBeenCalledOnce())
    expect(update.mock.calls[0][0].data.scopes).toEqual(['user:read'])
  })
  it('does not modify a partial grant when editing an unrelated field', async () => {
    mount(['user:read', 'inference:invoke'])
    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: 'Renamed' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(update).toHaveBeenCalledOnce())
    expect(update.mock.calls[0][0].data.scopes).toEqual(['user:read', 'inference:invoke'])
  })
  it('does not offer a mutation to a caller without app-update permission', () => {
    const toggle = mount(['user:read'], false)
    expect(toggle.hasAttribute('disabled') || toggle.getAttribute('aria-disabled') === 'true').toBe(true)
    fireEvent.click(toggle)
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull()
    expect(update).not.toHaveBeenCalled()
  })
  it('preserves all scopes when the control is untouched', () => {
    const scopes = ['payments:write', 'inference:invoke', 'user:read']
    expect(mergeAliaMachineScopes(scopes, null)).toEqual(scopes)
    expect(mergeAliaMachineScopes(scopes, true)).toEqual(['payments:write', 'user:read', 'alia:chat', 'inference:invoke'])
  })
})
