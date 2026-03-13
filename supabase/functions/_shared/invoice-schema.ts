export const invoiceJsonSchema = {
  name: "invoice_extraction",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      vendor: { type: "string" },
      invoice_number: { type: "string" },
      invoice_date: { type: "string" },
      po_number: { type: "string" },
      order_number: { type: "string" },
      shipment_number: { type: "string" },
      terms: { type: "string" },
      currency: { type: "string" },
      subtotal: { type: "number" },
      freight_charge: { type: "number" },
      drop_ship_charge: { type: "number" },
      misc_charges: { type: "number" },
      total_invoice: { type: "number" },
      lines: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            line_number: { type: "integer" },
            line_type: {
              type: "string",
              enum: ["PART", "FREIGHT", "DROP_SHIPMENT", "MISC"],
            },
            part_number: { type: "string" },
            description: { type: "string" },
            origin: { type: "string" },
            quantity: { type: "number" },
            unit_price: { type: "number" },
            discount_percent: { type: "number" },
            net_unit_price: { type: "number" },
            line_total: { type: "number" },
          },
          required: [
            "line_number",
            "line_type",
            "part_number",
            "description",
            "origin",
            "quantity",
            "unit_price",
            "discount_percent",
            "net_unit_price",
            "line_total",
          ],
        },
      },
    },
    required: [
      "vendor",
      "invoice_number",
      "invoice_date",
      "po_number",
      "order_number",
      "shipment_number",
      "terms",
      "currency",
      "subtotal",
      "freight_charge",
      "drop_ship_charge",
      "misc_charges",
      "total_invoice",
      "lines",
    ],
  },
} as const;

export type InvoiceLine = {
  line_number: number;
  line_type: "PART" | "FREIGHT" | "DROP_SHIPMENT" | "MISC";
  part_number: string;
  description: string;
  origin: string;
  quantity: number;
  unit_price: number;
  discount_percent: number;
  net_unit_price: number;
  line_total: number;
};

export type InvoiceExtraction = {
  vendor: string;
  invoice_number: string;
  invoice_date: string;
  po_number: string;
  order_number: string;
  shipment_number: string;
  terms: string;
  currency: string;
  subtotal: number;
  freight_charge: number;
  drop_ship_charge: number;
  misc_charges: number;
  total_invoice: number;
  lines: InvoiceLine[];
};