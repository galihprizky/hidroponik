function describeError(error) {
  const message = error.message || error.code || error.name || 'Unknown error';
  return error.code && !message.includes(error.code) ? `${error.code}: ${message}` : message;
}

export function formatMqttError(error) {
  if (error instanceof AggregateError && error.errors.length > 0) {
    return `${describeError(error)} (${error.errors.map(describeError).join('; ')})`;
  }
  return describeError(error);
}
