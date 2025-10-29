import fs from 'node:fs';
import path from 'node:path';
import { registerFont } from 'canvas';

const defaultFontconfigDir = '/etc/fonts';
const fallbackFontconfigDir = path.resolve(process.cwd(), 'config/fontconfig');
const fallbackFontsConf = path.join(fallbackFontconfigDir, 'fonts.conf');

const resolveFontconfigDir = () => {
  const configuredDir = process.env.FONTCONFIG_PATH ?? defaultFontconfigDir;
  const configuredFile = path.join(configuredDir, 'fonts.conf');

  if (fs.existsSync(configuredFile)) {
    return configuredDir;
  }

  if (fs.existsSync(fallbackFontsConf)) {
    return fallbackFontconfigDir;
  }

  return configuredDir;
};

const fontconfigDir = resolveFontconfigDir();
const fontsConfPath = path.join(fontconfigDir, 'fonts.conf');

process.env.FONTCONFIG_PATH = fontconfigDir;

if (!process.env.FONTCONFIG_FILE) {
  process.env.FONTCONFIG_FILE = fontsConfPath;
}

const fontPath = path.resolve(process.cwd(), 'assets/fonts/DejaVuSans.ttf');

if (fs.existsSync(fontPath)) {
  registerFont(fontPath, { family: 'DejaVu Sans' });
}

const { ChartJSNodeCanvas } = require('chartjs-node-canvas') as typeof import('chartjs-node-canvas');

export { ChartJSNodeCanvas };
