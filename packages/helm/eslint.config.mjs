// @ts-check
import tsBaseConfig from '@map-colonies/eslint-config/ts-base';
import vitestConfig from '@map-colonies/eslint-config/vitest';
import { config } from '@map-colonies/eslint-config/helpers';

export default config(tsBaseConfig, vitestConfig);
