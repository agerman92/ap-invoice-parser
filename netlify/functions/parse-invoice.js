exports.handler = async (event) => {
  try {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        success: true,
        method: event.httpMethod,
        bodyLength: event.body ? event.body.length : 0,
        isBase64Encoded: event.isBase64Encoded || false,
        contentType: event.headers["content-type"] || event.headers["Content-Type"] || null
      })
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        success: false,
        error: error.message
      })
    };
  }
};