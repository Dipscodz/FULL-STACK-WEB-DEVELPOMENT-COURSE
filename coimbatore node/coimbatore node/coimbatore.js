const axios = require("axios");
const { wrapper } = require("axios-cookiejar-support");
const tough = require("tough-cookie");
const cheerio = require("cheerio");
const FormData = require("form-data");
const fs = require("fs");
const { ImapFlow } = require("imapflow");
const { user_details } = require("./worker");


const BASE = "https://gzcoimbatore.com";
const LOGIN = `${BASE}/site/login/validate`;
const SEATS = `${BASE}/site/home/get_seats_available`;
const BOOKING = "https://gzcoimbatore.com/exam-registration/MjAyNjAyMjY=?k=0sAVhLHR4ehyJJcQO87AmHZHRW94NTJIbzBZRzdhVlh0NHpDaXc9PQ==";

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "X-Requested-With": "XMLHttpRequest",
  "Origin": BASE,
  "Referer": BOOKING,
  "Accept": "*/*",
  "Connection": "keep-alive"
};

function createSession() {
  const jar = new tough.CookieJar();
  return wrapper(axios.create({ jar, withCredentials: true }));
}


const qs = require("querystring");

async function login(session, user) {
  try {
    const payload = qs.stringify(user);
    const res = await session.post(LOGIN, payload, {
      headers: {
        ...HEADERS,
        "Content-Type": "application/x-www-form-urlencoded"
      }
    });
    console.log("LOGIN RESPONSE:", res.data);
    return !res.data.toLowerCase().includes("invalid");
  } catch (err) {
    console.log("LOGIN ERROR:", err.response?.data || err.message);
    return false;
  }
}

async function fetchDynamicIds(session, examType) {
  const { data: html } = await session.get(BOOKING);
  const $ = cheerio.load(html);

  const examId = html.match(/var\s+exam_id\s*=\s*"(\d+)"/)?.[1];
  const levelId = html.match(/var\s+level_id\s*=\s*"(\d+)"/)?.[1];
  
  // 🔥 ALL available modules (priority order)
  const allModules = [];
  $("#exam_module_id option").each((_, el) => {
    const val = $(el).attr("value");
    const text = $(el).text().toLowerCase();
    if (val && val !== "") {
      allModules.push({ id: val, text });
    }
  });

  // 🔥 PREFER user's examType, fallback to first available
  let moduleId = allModules.find(m => m.text.includes(examType.toLowerCase()))?.id;
  if (!moduleId) {
    moduleId = allModules[0]?.id; // First available module
  }

  const allTokens = html.match(/[a-zA-Z0-9]{20,100}/g) || [];
  const likelyCsrf = allTokens.find(token => 
    !token.match(/\d{4}-\d{2}-\d{2}/) && 
    !token.match(/^[0-9]+$/) &&          
    token.length > 25 && token.length < 80
  ) || "d41d8cd98f00b204e9800998ecf8427e";

  console.log("🔑 FIXED VALUES:", { 
    examId, 
    moduleId, 
    moduleText: allModules.find(m => m.id === moduleId)?.text,
    levelId, 
    csrf: likelyCsrf.slice(0, 20) + "..." 
  });
  
  return { examId, moduleId, levelId, csrfToken: likelyCsrf };
}

// 🔥 2X FASTER CAPMONSTER (300ms poll + better error handling)
async function solveRecaptchaV2Fast() {
  console.log("⚡ FAST CapMonster V2...");
  
  try {
    const createTask = await axios.post("https://api.capmonster.cloud/createTask", {
      clientKey: "a8976fd0ac4ed353105ef156ba7707a2",
      task: {
        type: "RecaptchaV2TaskProxyless",
        websiteURL: BOOKING,
        websiteKey: "6LeC1ZAqAAAAALYaPhW_cGxgvF1ls3vznEenNfBb",
        isInvisible: false
      }
    });
    
    if (createTask.data.errorId > 0) {
      console.log("❌ API ERROR:", createTask.data.errorDescription);
      return null;
    }
    
    const taskId = createTask.data.taskId;
    console.log("📤 Task:", taskId);
    
    
    for (let i = 0; i < 50; i++) {
      await new Promise(r => setTimeout(r, 300)); // 300ms = 15s total
      
      const result = await axios.post("https://api.capmonster.cloud/getTaskResult", {
        clientKey: "a8976fd0ac4ed353105ef156ba7707a2",
        taskId: taskId
      });
      
      if (result.data.status === "ready") {
        console.log(`✅ TOKEN in ${(i*0.3).toFixed(1)}s!`);
        return result.data.solution.gRecaptchaResponse;
      }
      
      if (result.data.status === "failed") {
        console.log("❌ Solver failed");
        return null;
      }
      
      // 🔥 Show progress every 10 polls
      if (i % 10 === 0) console.log(`⏳ ${i*0.3}s...`);
    }
    
  } catch (err) {
    console.log("💥 Network error:", err.message);
  }
  console.log("⏰ 15s timeout");
  return null;
}

async function getSeats(session, eid, mid, lid) {
  try {
    const payload = qs.stringify({ exam_id: eid, module_id: mid, level_id: lid });
    const res = await session.post(SEATS, payload, {
      headers: {
        ...HEADERS,
        "Content-Type": "application/x-www-form-urlencoded",
        "Referer": BOOKING,
        "Origin": BASE
      }
    });
    console.log("SEAT RAW RESPONSE:", res.data);
    return res.data;
  } catch (err) {
    console.log("SEAT ERROR:", err.response?.data || err.message);
    return null;
  }
}


async function sendOtp(session, examId) {
  try {
    const { data: html } = await session.get(BOOKING, { headers: HEADERS });
    const match = html.match(/id="gtoken"\s+value="([^"]+)"/);
    if (!match) return null;

    const gtoken = match[1];
    const payload = new URLSearchParams({ exam_id: examId, gtoken }).toString();
    
    const res = await session.post(`${BASE}/site/home/exam_OTP`, payload, {
      headers: {
        ...HEADERS,
        "Content-Type": "application/x-www-form-urlencoded"
      }
    });

    const text = JSON.stringify(res.data).toLowerCase();
    console.log("OTP SEND RESPONSE:", res.data);
    
    if (["yes", "1", "otp", "sent", "success"].some(s => text.includes(s))) {
      return gtoken;
    }
    return null;
  } catch (err) {
    console.log("OTP SEND ERROR:", err.response?.data || err.message);
    return null;
  }
}


async function fetchOtpFromGmail(email, password, timeout = 60) {
  const endTime = Date.now() + timeout * 1000;
  const client = new ImapFlow({
    host: "imap.gmail.com", port: 993, secure: true,
    auth: { user: email, pass: password }, logger: false
  });

  try {
    await client.connect();
    await client.mailboxOpen("INBOX");
    console.log("⚡ Waiting for OTP (100ms polling)...");

    while (Date.now() < endTime) {
      const uids = await client.search({ seen: false });
      if (uids.length > 0) {
        for (let uid of uids.reverse()) {
          const msg = await client.fetchOne(uid, { envelope: true, source: true });
          const from = msg.envelope?.from?.[0]?.address || "";
          if (!from.includes("gzcoimbatore")) continue;

          let body = msg.source.toString("utf8")
            .replace(/\u00a0/g, " ").replace(/\u200b/g, "");
          
          if (body.includes("<")) {
            const $ = cheerio.load(body);
            body = $.text();
          }

          const otpPatterns = [
            /OTP\s*[:\-]?\s*(\d{6})/i,
            /verification\s*code\s*[:\-]?\s*(\d{6})/i,
            /code\s*[:\-]?\s*(\d{6})/i,
            /\b(?!000000)(\d{6})\b/
          ];

          for (const pattern of otpPatterns) {
            const match = body.match(pattern);
            if (match && match[1] && match[1] !== "000000") {
              const otp = match[1];
              console.log("⚡ OTP FOUND:", otp);
              await client.messageFlagsAdd(uid, ["\\Seen"]);
              await client.logout();
              return otp;
            }
          }
        }
      }
      await new Promise(r => setTimeout(r, 100));
    }
    await client.logout();
    return null;
  } catch (err) {
    console.log("OTP Fetch Error:", err.message);
    return null;
  }
}


async function solveRecaptchaV2Fast() {
  console.log("⚡ ULTRA-FAST CapMonster (200ms polls)...");
  
  try {
    const createTask = await axios.post("https://api.capmonster.cloud/createTask", {
      clientKey: "a8976fd0ac4ed353105ef156ba7707a2",
      task: {
        type: "RecaptchaV2TaskProxyless",
        websiteURL: BOOKING,
        websiteKey: "6LeC1ZAqAAAAALYaPhW_cGxgvF1ls3vznEenNfBb",
        isInvisible: false
      }
    });
    
    if (createTask.data.errorId !== 0) {
      console.log("❌ API ERROR:", createTask.data);
      return null;
    }
    
    const taskId = createTask.data.taskId;
    console.log("📤 Task ID:", taskId);
    

    for (let i = 0; i < 65; i++) {
      await new Promise(r => setTimeout(r, 200)); // 200ms polls
      
      const result = await axios.post("https://api.capmonster.cloud/getTaskResult", {
        clientKey: "a8976fd0ac4ed353105ef156ba7707a2",
        taskId: taskId
      });
      
      console.log(`⏳ ${i+1}: ${result.data.status}`);
      
      if (result.data.status === "ready") {
        console.log(`✅ TOKEN in ${(i*0.2).toFixed(1)}s!`);
        return result.data.solution.gRecaptchaResponse;
      }
      
      if (result.data.status === "failed") {
        console.log("❌ Solver failed");
        return null;
      }
    }
  } catch (err) {
    console.log("💥 ERROR:", err.message);
  }
  console.log("⏰ 13s timeout");
  return null;
}


async function autoSubmitExam(session, user, eid, mid, lid, gtoken, csrfToken) {
  console.log("🔥 FINAL SUBMIT -", user.givenName);
  
  await session.get(BOOKING);
  console.log("🔄 Session refreshed");
  
  const recaptchaToken = await solveRecaptchaV2Fast();
  if (!recaptchaToken) {
    console.log("❌ CapMonster failed");
    return false;
  }
  
  console.log("✅ reCAPTCHA V2 ready!");
  
  const seatsJson = await getSeats(session, eid, mid, lid);
  const amount = seatsJson?.amount || "10600";
  const availableSeats = seatsJson?.available_seats || "5";

  const formFields = {
    "exam_id": eid,
    "exam_module_id": mid,
    "level_id": lid,
    "gtoken": gtoken,
    "g-recaptcha-response": recaptchaToken,
    "rtoken": recaptchaToken,
    "recaptcha": recaptchaToken,
    "terms": "1",
    "available_seats": availableSeats,
    "amount_payable": amount,
    "total_amount": amount,
    "items": mid,
    "ci_csrf_token": csrfToken,
    "exam_is_custom": "0",
    "name": user.givenName,
    "surname": user.surname,
    "mobile": user.mobileNo,
    "email": user.email,
    "dateofbirth": user.dob,
    "placeofbirth": user.placeOfBirth,
    "address": user.address,
    "occupation": user.occupation,
    "mothertongue": user.motherTongue,
    "nationality": user.nationality || "Indian",
    "purpose": user.purpose || "Exam",
    "goetheexaminationbefore": user.goetheExaminationBefore || "No",
    "whenandwhere": user.whenAndWhere || "",
    "participant_no": user.participantNo || "",
  };

  console.log("📋 Form ready. Uploading photo...");
  
  const finalForm = new FormData();
  for (let [key, value] of Object.entries(formFields)) {
    finalForm.append(key, value);
  }
  
  finalForm.append("photo", fs.createReadStream(user.idProofPath));
  console.log("📸 Photo uploaded");

  try {
    console.log("🚀 FINAL REQUEST...");
    const res = await session.post(`https://gzcoimbatore.com/exam-insert`, finalForm, {
      headers: finalForm.getHeaders(),
      timeout: 30000
    });
    
    const responseText = res.data.toString().trim();
    console.log("🎯 RESPONSE:", JSON.stringify(res.data));
    console.log("📊 STATUS:", res.status);

    const isSuccess = responseText === "yes" && res.status === 200;  // 🔥 FIXED!

    console.log("✅ SUCCESS CHECK:", isSuccess);

    if (isSuccess) {
      console.log(`🎉🎊 ${user.givenName} BOOKED SUCCESSFULLY! 🎊🎉`);
      return true;
    } else if (responseText === "completed") {
      console.log("❌ SEATS SOLD OUT - Try different module");
      return false;
    } else {
      console.log("❌ Server rejected:", responseText);
      return false;
    }
  } catch (e) {
    console.log("💥 ERROR:", e.response?.data || e.message);
    return false;
  }
}  // ← This closing brace was MISSING!

// ================= MAIN LOOP =================
async function checkUser(user) {
  const session = createSession();

  while (true) {
    console.log(`\n👤 [${user.email}] Checking seats...`);

    if (!(await login(session, user))) {
      console.log("❌ Login failed");
      await new Promise(r => setTimeout(r, 30000));
      continue;
    }

    // 🔥 GET CSRF + DYNAMIC VALUES
    const { examId, moduleId, levelId, csrfToken } = await fetchDynamicIds(session, user.examType);
    
    if (!examId || !moduleId || !levelId) {
      console.log("❌ Missing exam IDs");
      await new Promise(r => setTimeout(r, 30000));
      continue;
    }
    
    if (!csrfToken) {
      console.log("❌ NO CSRF TOKEN - Booking will fail!");
      await new Promise(r => setTimeout(r, 30000));
      continue;
    }

    const result = await getSeats(session, examId, moduleId, levelId);
    const seats = parseInt(result?.available_seats || 0);

    if (seats > 0) {
      console.log(`🚨🎯 SEATS AVAILABLE: ${seats}`);

      const gtoken = await sendOtp(session, examId);
      if (!gtoken) {
        console.log("❌ OTP send failed");
        return;
      }

      console.log("⏳ Waiting 3s for OTP delivery...");
      await new Promise(r => setTimeout(r, 3000));

      const otp = await fetchOtpFromGmail(user.email, user.gmail_app_password);
      if (!otp) {
        console.log("❌ No OTP received");
        return;
      }

      console.log("📩 OTP RECEIVED:", otp);

      const payload = qs.stringify({ otp: otp.trim(), gtoken, exam_id: examId });
      const verify = await session.post(`${BASE}/site/home/verify_exam_OTP`, payload, {
        headers: { ...HEADERS, "Content-Type": "application/x-www-form-urlencoded" }
      });

      console.log("OTP VERIFY RESPONSE:", verify.data);

      if (!JSON.stringify(verify.data).toLowerCase().includes("yes")) {
        console.log("❌ OTP verification failed");
        return;
      }

      // 🔥 PASS CSRF TOKEN TO SUBMIT
      const booked = await autoSubmitExam(session, user, examId, moduleId, levelId, gtoken, csrfToken);
      if (booked) {
        console.log("🎊🎊 TOTAL SUCCESS! Booking confirmed! 🎊🎊");
        return;
      } else {
        console.log("❌ Final submit failed - server rejected");
        return;
      }
    }

    console.log(`⏳ No seats (${seats}). Waiting 30s...`);
    await new Promise(r => setTimeout(r, 30000));
  }
}


(async () => {
  console.log("🚀 CSRF-FIXED GOETHE COIMBATORE BOT STARTED");
  console.log("✅ CapMonster V2 + Real CSRF + Photo detection");
  await Promise.all(user_details.map((user, i) => {
    console.log(`\n👥 Starting User ${i+1}: ${user.email}`);
    return checkUser(user);
  }));
})();
