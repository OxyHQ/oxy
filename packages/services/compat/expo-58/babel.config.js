module.exports = (api) => {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    overrides: [
      {
        test: /[\\/]node_modules[\\/]@oxy\.so[\\/]bloom[\\/]lib[\\/]/,
        presets: [['babel-preset-expo', { reanimated: false }]],
      },
    ],
  };
};
