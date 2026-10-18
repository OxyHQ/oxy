// Metro turns bundled video assets into numeric module references.
declare module '*.mp4' {
  const source: number;
  export default source;
}
