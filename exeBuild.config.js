module.exports = {
    file: 'dist/main.js',
    icon: 'apps/server/src/assets/images/tail.ico',
    name: 'fbw-simbridge',
    description: 'Application for providing external service to FlyByWire aircraft',
    company: 'FlyByWire Simulations',
    version: '0.3.11',
    copyright: 'GNU v3',
    pkg: {
        targets: [
            'node16-win-x64',
        ],
        assets: [
            'node_modules/linebreak/src/classes.trie',
            'node_modules/skia-canvas/**/*.*',
            'node_modules/canvas/**/*.*',
            'node_modules/pdfkit/js/data/Helvetica.afm',
            'dist/mcdu/**/*',
            'dist/assets/**/*',
            'dist/terrain/manager/maploader.js',
            'dist/terrain/utils/**/*.js',
        ],
        outputPath: 'build',
    },
};
