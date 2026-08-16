/**
 * @file Capacitor config — the Play Store shell
 * @description Wraps the built client (dist/) in a native Android app. The
 *   shell bundles the UI only; users connect out to their own self-hosted
 *   PersaLink servers via the in-app server registry. allowMixedContent +
 *   cleartext are required because those servers are usually plain ws/http
 *   on a LAN or tailnet.
 */
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.brobata.persalink',
  appName: 'PersaLink',
  webDir: 'dist',
  android: {
    allowMixedContent: true,
  },
};

export default config;
