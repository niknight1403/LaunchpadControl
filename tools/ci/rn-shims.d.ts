/**
 * React Native / Expo module stubs for CI type-checking.
 *
 * CI does not install the React Native toolchain (a ~600 MB install for types
 * only). These stubs keep the check meaningful: our own code is still checked
 * strictly, including every call into our modules. What is lost is RN's own
 * type surface, which is why the responder-event types in the components are
 * structural rather than imported.
 *
 * For the real thing, run `npm run typecheck` (uses expo/tsconfig.base) after
 * `npm install`.
 */
declare module 'react-native';
declare module 'expo';
declare module 'expo-status-bar';
declare module 'expo-haptics';
declare module 'expo-file-system';
declare module 'expo-document-picker';
declare module 'react-native-svg';
declare module 'react-native-gesture-handler';
declare module 'react-native-safe-area-context';
declare module 'react-native-reanimated';
