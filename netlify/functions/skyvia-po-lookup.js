export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") {
      return {
        statusCode: 405,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          success: false,
          error: "Method not allowed"
        })
      };
    }

    const body = JSON.parse(event.body || "{}");
    const poNumber = String(body.poNumber || "").trim();

    if (!poNumber || !/^\d+$/.test(poNumber)) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          success: false,
          error: "A valid numeric poNumber is required"
        })
      };
    }

    const skyviaUrl = process.env.SKYVIA_SQL_ENDPOINT_URL;
    const skyviaUser = process.env.SKYVIA_SQL_ENDPOINT_USER;
    const skyviaPassword = process.env.SKYVIA_SQL_ENDPOINT_PASSWORD;

    if (!skyviaUrl || !skyviaUser || !skyviaPassword) {
      return {
        statusCode: 500,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          success: false,
          error: "Missing Skyvia environment variables"
        })
      };
    }

    const basicAuth = Buffer.from(`${skyviaUser}:${skyviaPassword}`).toString("base64");

    const endpoint = skyviaUrl.endsWith("/execute")
      ? skyviaUrl
      : `${skyviaUrl}/execute`;

    const skyviaResponse = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Basic ${basicAuth}`
      },
      body: JSON.stringify({
        query: `
          SELECT
            DetailPONumber,
            DetailItemName,
            Quantity,
            UnitCost,
            DetailTotal
          FROM [WinNetStarApp].[dbo].[IRBillDetail]
          WHERE DetailPONumber = @poNumber
        `,
        parameters: {
          poNumber: Number(poNumber)
        }
      })
    });

    const rawText = await skyviaResponse.text();

    let data;
    try {
      data = JSON.parse(rawText);
    } catch {
      data = { raw: rawText };
    }

    return {
      statusCode: skyviaResponse.ok ? 200 : skyviaResponse.status,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        success: skyviaResponse.ok,
        poNumber: Number(poNumber),
        endpoint,
        data
      })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        success: false,
        error: err.message
      })
    };
  }
}