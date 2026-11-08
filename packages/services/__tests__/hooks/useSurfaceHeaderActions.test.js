const { renderHook } = require('@testing-library/react');
const { createElement } = require('react');
const { SurfaceHeaderContext, useSurfaceHeader } = require('../../src/ui/hooks/useSurfaceHeader');

// Runtime contracts cover both Bloom generations. The separate packed-consumer
// check compiles the semantic-only union against published Bloom declarations.
const icon = () => null;
const command = () => ({ id: 'save', label: 'Save', icon, onPress: jest.fn() });
function fixture(initial) {
  const setContent = jest.fn();
  const wrapper = ({ children }) =>
    createElement(SurfaceHeaderContext.Provider, { value: { setContent } }, children);
  const hook = renderHook(({ actions, right }) => useSurfaceHeader({ actions, right }), {
    wrapper,
    initialProps: { actions: initial },
  });
  return { ...hook, setContent };
}

test.each([
  ['id', 'archive'],
  ['label', 'Guardar'],
  ['icon', () => null],
  ['group', 'file'],
  ['priority', 10],
  ['essential', true],
  ['overflow', 'always'],
  ['visible', false],
  ['disabled', true],
  ['busy', true],
  ['selected', false],
  ['labelVisibility', 'hidden'],
])('publishes a semantic action change in %s', (key, value) => {
  const action = command();
  const { rerender, setContent } = fixture([action]);
  rerender({ actions: [{ ...action, [key]: value }] });
  expect(setContent).toHaveBeenCalledTimes(2);
  expect(setContent.mock.lastCall[0].actions[0][key]).toBe(value);
});

test('accepts pure semantic entries and avoids pushes for inline callbacks/default flags', () => {
  const action = command();
  const { rerender, setContent } = fixture([action]);
  const latest = jest.fn();
  rerender({
    actions: [
      {
        ...action,
        onPress: latest,
        visible: true,
        busy: false,
        disabled: false,
        essential: false,
        priority: 0,
        overflow: 'auto',
        labelVisibility: 'auto',
      },
    ],
  });
  expect(setContent).toHaveBeenCalledTimes(1);
  setContent.mock.calls[0][0].actions[0].onPress();
  expect(action.onPress).not.toHaveBeenCalled();
  expect(latest).toHaveBeenCalledTimes(1);
});

test('retained semantic callbacks follow IDs across reordering and stop after removal/unmount', () => {
  const first = command();
  const second = { ...command(), id: 'archive', label: 'Archive' };
  const { rerender, setContent, unmount } = fixture([first, second]);
  const retained = setContent.mock.calls[0][0].actions[0].onPress;
  const latest = jest.fn();
  rerender({ actions: [second, { ...first, onPress: latest }] });
  retained();
  expect(latest).toHaveBeenCalledTimes(1);
  expect(second.onPress).not.toHaveBeenCalled();
  rerender({ actions: [second] });
  retained();
  expect(latest).toHaveBeenCalledTimes(1);
  unmount();
  retained();
  expect(latest).toHaveBeenCalledTimes(1);
});

test('keeps legacy accessible names, positional callbacks and custom nodes', () => {
  const first = jest.fn();
  const action = { accessibilityLabel: 'More', icon, onPress: first };
  const { rerender, setContent } = fixture([action]);
  const retained = setContent.mock.calls[0][0].actions[0].onPress;
  const latest = jest.fn();
  rerender({ actions: [{ ...action, onPress: latest }] });
  expect(setContent).toHaveBeenCalledTimes(1);
  retained();
  expect(latest).toHaveBeenCalledTimes(1);
  rerender({ actions: [{ ...action, accessibilityLabel: 'Más' }] });
  expect(setContent).toHaveBeenCalledTimes(2);
  const right = createElement('input', { defaultValue: 'custom' });
  rerender({ actions: [action], right });
  expect(setContent.mock.lastCall[0].right).toBe(right);
  rerender({ actions: [{ ...action }], right });
  expect(setContent).toHaveBeenCalledTimes(3);
});
