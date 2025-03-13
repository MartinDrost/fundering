const logError = (error: Error | any, context?: string) => {
  const message: string[] = [];
  if (context) {
    message.push(`[${context}]`);
  }
  if (error instanceof Error) {
    message.push(error.message);
  } else {
    message.push(error);
  }

  console.log(message.join(" "));
};

export { logError };
