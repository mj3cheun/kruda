'use strict';

const path = require('path');
const packageJson = require('./package.json');
const eslint = require('rollup-plugin-eslint').eslint;
const liveServer = require('rollup-plugin-live-server');
const resolve = require('rollup-plugin-node-resolve');
const webWorkerLoader = require('rollup-plugin-web-worker-loader');
const urlLoader = require('rollup-plugin-url');
const commonjs = require('rollup-plugin-commonjs');
const jscc = require('rollup-plugin-jscc');

const moduleName = packageJson.name.split('/').pop();
const JS_OUTPUT = `${moduleName}.js`;
const isBrowser = (process.env.TARGET === 'browser');
const outputName = JS_OUTPUT;

const config = {
    input: path.resolve(__dirname, packageJson.entry),
    output: [],
    plugins: [
        resolve(),
        commonjs({ include: 'node_modules/**' }),
        eslint(),
        webWorkerLoader({
            sourcemap: isBrowser,
            inline: !isBrowser,
            loadPath: 'dist/iife/',
        }),
        urlLoader({
            limit: 1024 * 1024 * 1024, // 1GB - Basically unlimited
            include: ['**/*.wasm'],
            emitFiles: false,
        }),
        jscc({
            prefixes: '/// ',
            sourcemap: false,
            values: {
                _DEBUG: false,
            },
        }),
    ],
};

if (isBrowser) {
    config.output.push({
        file: path.resolve(__dirname, `dist/iife/${outputName}`),
        format: 'iife',
        name: moduleName,
        sourcemap: 'inline',
    });

    config.plugins.push(liveServer({
        port: 8090,
        host: '0.0.0.0',
        root: 'www',
        file: 'index.html',
        mount: [['/dist/iife', './dist/iife']],
        open: false,
        wait: 500,
        middleware: [
            function(req, res, next) {
                res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
                res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
                next();
            },
        ],
    }));
} else {
    config.output.push({
        file: path.resolve(__dirname, `dist/amd/${outputName}`),
        format: 'amd',
        sourcemap: true,
    });

    config.output.push({
        file: path.resolve(__dirname, `dist/cjs/${outputName}`),
        format: 'cjs',
        sourcemap: true,
    });

    config.output.push({
        file: path.resolve(__dirname, `dist/esm/${outputName}`),
        format: 'esm',
        sourcemap: true,
    });

    config.output.push({
        file: path.resolve(__dirname, `dist/umd/${outputName}`),
        format: 'umd',
        name: moduleName,
        sourcemap: true,
    });

    config.output.push({
        file: path.resolve(__dirname, `dist/iife/${outputName}`),
        format: 'iife',
        name: moduleName,
        sourcemap: true,
    });
}

module.exports = config;
