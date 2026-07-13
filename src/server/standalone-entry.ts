try {
  const [{ startStandalone }, { embeddedPlugins }] = await Promise.all([
    import('./standalone.js'),
    import('./embeddedPlugins.js')
  ]);
  await startStandalone({ plugins: embeddedPlugins });
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
