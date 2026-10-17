declare module '*.ttf' {
  const asset: number;
  export default asset;
}

declare module '*.mp4' {
  const source: number;
  export default source;
}

declare module '*.jpg' {
  const source: import('react-native').ImageSourcePropType;
  export default source;
}
