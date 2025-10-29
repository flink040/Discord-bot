import path from 'node:path';

const defaultFontconfigDir = '/etc/fonts';

if (!process.env.FONTCONFIG_PATH) {
  process.env.FONTCONFIG_PATH = defaultFontconfigDir;
}

if (!process.env.FONTCONFIG_FILE) {
  process.env.FONTCONFIG_FILE = path.join(process.env.FONTCONFIG_PATH, 'fonts.conf');
}

const { ChartJSNodeCanvas } = require('chartjs-node-canvas') as typeof import('chartjs-node-canvas');

export { ChartJSNodeCanvas };
