const winston = require('winston');
const path = require('path');

// Define log format
const logFormat = winston.format.printf(({ level, message, timestamp, stack }) => {
    return `${timestamp} [${level.toUpperCase()}]: ${stack || message}`;
});

const sensitiveKeys = ['password', 'secret', 'token', 'key', 'credential', 'auth', 'private_key', 'authorization'];

const redactor = winston.format((info) => {
    const mask = (obj) => {
        if (!obj || typeof obj !== 'object') return obj;

        // Deep clone to avoid mutating original object if needed, 
        // but for logging stream modify info is usually acceptable or shallow copy keys
        for (const key in obj) {
            if (obj.hasOwnProperty(key)) {
                if (sensitiveKeys.some(s => key.toLowerCase().includes(s))) {
                    obj[key] = '***REDACTED***';
                } else if (typeof obj[key] === 'object') {
                    mask(obj[key]);
                }
            }
        }
        return obj;
    };
    return mask(info);
});

const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        redactor(), // Apply redaction first
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.errors({ stack: true }),
        logFormat
    ),
    transports: [
        // Console transport for real-time logs (e.g., Render logs)
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                logFormat
            )
        }),
        // File transport for error logs
        new winston.transports.File({
            filename: path.join(__dirname, 'logs', 'error.log'),
            level: 'error'
        }),
        // File transport for all logs
        new winston.transports.File({
            filename: path.join(__dirname, 'logs', 'combined.log')
        })
    ]
});

module.exports = logger;
