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
    const endpoint = skyviaUrl.endsWith("/execute") ? skyviaUrl : `${skyviaUrl}/execute`;

    const sql = `
      SELECT
        DetailPONumber,
        DetailItemName,
        Quantity,
        UnitCost,
        DetailTotal
      FROM [WinNetStarApp].[dbo].[IRBillDetail]
      WHERE DetailPONumber = ${poNumber}
      ORDER BY DetailItemName
    `;

    const skyviaResponse = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Basic ${basicAuth}`
      },
      body: JSON.stringify({ sql })
    });

    const rawText = await skyviaResponse.text();

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      parsed = null;
    }

    if (!skyviaResponse.ok) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          success: false,
          poNumber: Number(poNumber),
          endpoint,
          sql,
          error: parsed || rawText
        })
      };
    }

    const rows = parsed?.data || [];
    const recordsCount = parsed?.recordsCount || rows.length;

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        success: true,
        poNumber: Number(poNumber),
        recordsCount,
        rows
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