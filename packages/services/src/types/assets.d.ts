declare module '*.ttf' {
  const asset: number;
  export default asset;
}

/** An image: a URL under Vite, an asset id under Metro — either is an image source. */
declare module '*.jpg' {
  const asset: string | number;
  export default asset;
}
