/**
 * Example Plugin
 *
 * A simple plugin that demonstrates the plugin system.
 * This plugin adds a /hello endpoint that returns a greeting.
 */

import { Router } from 'express';

export default class ExamplePlugin {
    constructor() {
        this.manifest = null;
    }

    async initialize(context) {
        context.logger.info('Example plugin initialized!');
        this.context = context;
    }

    getRouter() {
        const router = Router();

        router.get('/hello', (req, res) => {
            res.json({
                message: 'Hello from Example Plugin!',
                timestamp: new Date().toISOString()
            });
        });

        router.post('/echo', (req, res) => {
            res.json({
                echo: req.body,
                plugin: 'example-plugin'
            });
        });

        return router;
    }

    async shutdown() {
        this.context.logger.info('Example plugin shutting down');
    }
}
