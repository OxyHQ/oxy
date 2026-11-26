import { layout, TabView } from '@oxy.so/bloom-language/router';

/**
 * The tabs group's navigator over the app's destinations: the system tab bar
 * on iOS, Bloom's pager on Android (swiped between) and the routed page on the
 * web.
 */
export default layout(() => TabView());
