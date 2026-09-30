// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RoutingProfile } from '@oxy.so/contracts'
import type { RoutingPolicyControls } from '@/lib/routing-policy'
import { RoutingPolicyForm } from '@/components/apps/routing-policy-form'
import { defaultRoutingPolicyControls } from '@/lib/routing-policy'

afterEach(cleanup)

function profile(slug: string): RoutingProfile {
  return {
    schemaVersion: 1,
    routingProfileId: `power-${slug}`,
    slug,
    displayName: slug.charAt(0).toUpperCase() + slug.slice(1),
    optimiseFor: 'price',
    candidates: [{ modelReference: 'publisher/model', priority: 0 }],
    isProductPreset: true,
    powerLevel: slug as RoutingProfile['powerLevel'],
  }
}

// Shuffled, as the API orders by slug; the form shows the contract's ladder.
const PROFILES = [
  'ultra',
  'auto',
  'pro',
  'instant',
  'xhigh',
  'high',
  'medium',
].map(profile)

function renderForm(initial: Partial<RoutingPolicyControls> = {}) {
  const onSubmit = vi.fn()
  render(
    <RoutingPolicyForm
      initial={{ ...defaultRoutingPolicyControls(), ...initial }}
      submitLabel="Save new version"
      isPending={false}
      catalogue={[]}
      routingProfiles={PROFILES}
      onSubmit={onSubmit}
      onCancel={() => {}}
    />,
  )
  return { onSubmit }
}

function checkbox(routingProfileId: string): HTMLInputElement {
  return document.getElementById(
    `routing-allowed-${routingProfileId}`,
  ) as HTMLInputElement
}

describe('RoutingPolicyForm — power levels', () => {
  it('offers every published level, in ladder order, unticked = unrestricted', () => {
    renderForm()

    const ids = Array.from(
      document.querySelectorAll<HTMLInputElement>(
        'input[id^="routing-allowed-"]',
      ),
    ).map((input) => input.id.replace('routing-allowed-', ''))
    expect(ids).toEqual([
      'power-auto',
      'power-instant',
      'power-medium',
      'power-high',
      'power-xhigh',
      'power-pro',
      'power-ultra',
    ])
    expect(screen.getByText(/Nothing ticked means unrestricted/)).toBeTruthy()
  })

  it('writes instant-only with instant as the default (Oxy Inbox)', () => {
    const { onSubmit } = renderForm({
      defaultTarget: {
        kind: 'routing_profile_id',
        routingProfileId: 'power-instant',
      },
    })

    fireEvent.click(checkbox('power-instant'))
    fireEvent.click(screen.getByRole('button', { name: 'Save new version' }))

    expect(onSubmit).toHaveBeenCalledTimes(1)
    const saved = onSubmit.mock.calls[0]?.[0] as RoutingPolicyControls
    expect(saved.allowedRoutingProfileIds).toEqual(['power-instant'])
    expect(saved.defaultTarget).toEqual({
      kind: 'routing_profile_id',
      routingProfileId: 'power-instant',
    })
  })

  it('writes every level with auto as the default (Alia), in ladder order', () => {
    const { onSubmit } = renderForm({
      defaultTarget: {
        kind: 'routing_profile_id',
        routingProfileId: 'power-auto',
      },
    })

    for (const slug of [
      'ultra',
      'instant',
      'auto',
      'medium',
      'high',
      'xhigh',
      'pro',
    ]) {
      fireEvent.click(checkbox(`power-${slug}`))
    }
    fireEvent.click(screen.getByRole('button', { name: 'Save new version' }))

    const saved = onSubmit.mock.calls[0]?.[0] as RoutingPolicyControls
    expect(saved.allowedRoutingProfileIds).toEqual([
      'power-auto',
      'power-instant',
      'power-medium',
      'power-high',
      'power-xhigh',
      'power-pro',
      'power-ultra',
    ])
  })

  it('refuses to save a default outside the allowed list, naming why', () => {
    const { onSubmit } = renderForm({
      defaultTarget: {
        kind: 'routing_profile_id',
        routingProfileId: 'power-auto',
      },
    })

    fireEvent.click(checkbox('power-instant'))
    expect(screen.getByRole('alert').textContent).toContain(
      'not one of the allowed power levels',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Save new version' }))

    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByText('This policy cannot be saved yet')).toBeTruthy()
  })

  it('keeps a saved level that is not currently published', () => {
    const { onSubmit } = renderForm({
      allowedRoutingProfileIds: ['power-instant', 'power-legacy'],
    })

    expect(checkbox('power-legacy').checked).toBe(true)
    expect(screen.getByText(/Not currently published/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Save new version' }))

    const saved = onSubmit.mock.calls[0]?.[0] as RoutingPolicyControls
    expect(saved.allowedRoutingProfileIds).toEqual([
      'power-instant',
      'power-legacy',
    ])
  })

  it('clears back to unrestricted', () => {
    const { onSubmit } = renderForm({
      allowedRoutingProfileIds: ['power-instant'],
    })

    fireEvent.click(
      screen.getByRole('button', { name: 'Clear (allow every level)' }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Save new version' }))

    const saved = onSubmit.mock.calls[0]?.[0] as RoutingPolicyControls
    expect(saved.allowedRoutingProfileIds).toEqual([])
  })
})
