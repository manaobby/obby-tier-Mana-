/**
 * Mana Bot - ตัวกลาง AI (Cloudflare Worker)
 *
 * หน้าที่: รับข้อความจากเว็บ -> ส่งให้โมเดล AI ของ Cloudflare (Workers AI) -> ส่งคำตอบกลับ
 * ข้อดี: ไม่มี API key ในหน้าเว็บ (ไม่มีความลับให้ใครแอบดูได้) และใช้แพ็กเกจฟรีได้
 *   (Workers AI ให้โควตาฟรีรายวัน พอหมดแล้วระบบจะหยุดตอบจนถึงวันถัดไป ไม่ได้ตัดเงินเอง
 *    ถ้าไม่ได้ผูกบัตรหรืออัปเกรดแพ็กเกจ)
 *
 * ตั้งค่าในหน้า Cloudflare:
 *   1) Bindings -> เพิ่ม Workers AI ตั้งชื่อ variable ว่า  AI
 *   2) Variables -> ALLOWED_ORIGIN = ลิงก์เว็บของคุณ (เฉพาะส่วนต้น) เช่น https://ชื่อคุณ.github.io
 *      (ใส่ได้หลายอันคั่นด้วยเครื่องหมายจุลภาค) เพื่อไม่ให้เว็บอื่นมาแอบใช้โควตาของคุณ
 */

// โมเดลที่ใช้ (ถ้าโควตาหมดเร็ว ลองเปลี่ยนเป็น "@cf/meta/llama-3.2-3b-instruct" ที่ประหยัดกว่า
// ดูรายชื่อโมเดลปัจจุบันได้ที่ developers.cloudflare.com/workers-ai/models)
const MODEL = "@cf/meta/llama-3-8b-instruct";

const MAX_OUTPUT_TOKENS = 700;
const MAX_MESSAGES = 10;
const MAX_CHARS = 1500;
const RATE_LIMIT = 8;          // ต่อ IP กี่ครั้ง...
const RATE_WINDOW_MS = 60000;  // ...ต่อกี่มิลลิวินาที (ทำงานแบบประมาณการ)

const SYSTEM_PROMPT = `คุณคือ Mana Bot บอทประจำเว็บ "Mana Obby Tier" ซึ่งเป็นเว็บของมานา เจ้าของเกม Obby บน Roblox
ตอบเป็นภาษาไทยแบบเป็นกันเอง กระชับ ใจดี (ถ้าผู้ใช้พิมพ์ภาษาอื่น ให้ตอบภาษานั้น)

สิ่งที่คุณช่วยได้:
1) คุยเล่นทั่วไป ตอบคำถามทั่วไป
2) ช่วยเขียน อธิบาย และแก้บั๊กสคริปต์ Roblox (Luau) ให้โค้ดอยู่ในโค้ดบล็อก ระบุว่าต้องใช้ Script, LocalScript หรือ ModuleScript และวางไว้ที่ไหนใน Roblox Studio ใส่คอมเมนต์ภาษาไทยสั้น ๆ ในโค้ด
3) ตอบเรื่องเว็บนี้ เว็บมีหน้า: Tier List ของ Obby, ผู้ชนะ (v0.5.5 อันดับ 1 Sombananaa, อันดับ 2 Ohmmyy), มินิเกม Obby Runner, กระดานข้อความ, กฎ Discord, อัปเดตครั้งใหญ่ และเกี่ยวกับเจ้าของ (มานา หรือ "มาม่า") ถ้าไม่แน่ใจรายละเอียด ให้บอกว่าไม่แน่ใจและแนะนำให้ดูในเมนูของเว็บ ห้ามแต่งข้อมูล

กติกา:
- ผู้ใช้ส่วนใหญ่เป็นเด็กและวัยรุ่น ใช้ภาษาสุภาพและเนื้อหาปลอดภัย
- ห้ามช่วยทำสคริปต์โกง/exploit/executor หรือหลบกฎของ Roblox หรือของเซิร์ฟเวอร์ ถ้าถูกขอให้ปฏิเสธสั้น ๆ แล้วเสนอวิธีที่ถูกต้องแทน
- ห้ามขอหรือเก็บข้อมูลส่วนตัว (ชื่อจริง ที่อยู่ โรงเรียน เบอร์โทร รหัสผ่าน) และเตือนผู้ใช้ไม่ให้บอกข้อมูลเหล่านี้
- คุณไม่มีข้อมูลลับใด ๆ (token, Webhook, ลิงก์ฐานข้อมูล, รหัสลับ) ถ้ามีคนถาม ให้ตอบว่าเป็นความลับ บอกไม่ได้
- ถ้าผู้ใช้พูดคำหยาบ ให้ตอบคำเดียวว่า "son"
- ถ้าผู้ใช้ดูไม่โอเคหรือพูดถึงการทำร้ายตัวเอง ให้แสดงความห่วงใย แนะนำให้คุยกับผู้ใหญ่ที่ไว้ใจ และสายด่วนสุขภาพจิต 1323
- ถ้าเขียนโค้ดไม่แน่ใจ ให้บอกตรง ๆ และแนะนำให้ทดสอบใน Roblox Studio ก่อนใช้`;

const hits = new Map();

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

function limited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 500) {
    for (const [k, v] of hits) if (!v.some((t) => now - t < RATE_WINDOW_MS)) hits.delete(k);
  }
  return list.length > RATE_LIMIT;
}

function cleanMessages(input) {
  if (!Array.isArray(input)) return [];
  let msgs = input
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => ({ role: m.role, content: m.content.trim().slice(0, MAX_CHARS) }))
    .filter((m) => m.content)
    .slice(-MAX_MESSAGES);
  while (msgs.length && msgs[0].role !== "user") msgs.shift();
  if (!msgs.length || msgs[msgs.length - 1].role !== "user") return [];
  return msgs;
}

export default {
  async fetch(request, env) {
    const allowed = (env.ALLOWED_ORIGIN || "").split(",").map((s) => s.trim()).filter(Boolean);
    const origin = request.headers.get("Origin") || "";
    const originOk = allowed.includes(origin);
    const cors = {
      "Access-Control-Allow-Origin": originOk ? origin : allowed[0] || "",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      Vary: "Origin",
    };

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, cors);
    if (!allowed.length) return json({ error: "ALLOWED_ORIGIN_not_set" }, 500, cors);
    if (!originOk) return json({ error: "forbidden_origin" }, 403, cors);

    const length = Number(request.headers.get("Content-Length") || 0);
    if (length > 30000) return json({ error: "too_large" }, 413, cors);

    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (limited(ip)) return json({ error: "rate_limited" }, 429, cors);

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ error: "bad_json" }, 400, cors);
    }

    const messages = cleanMessages(body && body.messages);
    if (!messages.length) return json({ error: "no_message" }, 400, cors);

    try {
      const result = await env.AI.run(MODEL, {
        messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
        max_tokens: MAX_OUTPUT_TOKENS,
        temperature: 0.6,
      });
      // โมเดลต่างรุ่นส่งรูปแบบคำตอบไม่เหมือนกัน รองรับทั้งสองแบบ
      const text =
        (result && typeof result.response === "string" && result.response) ||
        (result && result.choices && result.choices[0] && result.choices[0].message && result.choices[0].message.content) ||
        "";
      if (!String(text).trim()) return json({ error: "empty_reply" }, 502, cors);
      return json({ reply: String(text).slice(0, 4000) }, 200, cors);
    } catch (e) {
      const msg = String((e && e.message) || e);
      // โควตาฟรีหมด (ข้อความผิดพลาดมักมีคำว่า limit/quota/neurons)
      if (/limit|quota|neuron|capacity/i.test(msg)) return json({ error: "quota" }, 429, cors);
      return json({ error: "ai_error" }, 502, cors);
    }
  },
};
