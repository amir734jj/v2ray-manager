export function createErrorHandler(logger) {
  return (error, _request, response, next) => {
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 500 ? error.status : 500;
    const message = error.type === 'entity.parse.failed' ? 'Invalid JSON request' : error.message;
    if (status < 500) logger.warn({ status, reason: message }, 'Gateway status page error');
    else logger.error({ err: error }, 'Gateway status page error');
    if (response.headersSent) {
      next(error);
      return;
    }
    response.status(status).json({ error: status < 500 ? message : 'Internal Server Error' });
  };
}
