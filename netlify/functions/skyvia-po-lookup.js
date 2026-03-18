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

    const payload = {
      sql
    };

    const skyviaResponse = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Basic ${basicAuth}`
      },
      body: JSON.stringify(payload)
    });

    const rawText = await skyviaResponse.text();

    let data;
    try {
      data = JSON.parse(rawText);
    } catch {
      data = { raw: rawText };
    }

    return {
      statusCode: skyviaResponse.ok ? 200 : 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        success: skyviaResponse.ok,
        poNumber: Number(poNumber),
        endpoint,
        sql,
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