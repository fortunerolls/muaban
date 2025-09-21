/* ==========================================================================
   Muaban.vin — app.js (FULL)
   Tác vụ: Kết nối ví, đăng ký, hiển thị sản phẩm, đăng/cập nhật, mua hàng,
           xem đơn mua/bán, xác nhận nhận hàng, hoàn tiền.
   Phù hợp với index.html:contentReference[oaicite:4]{index=4}, style.css:contentReference[oaicite:5]{index=5}, mô tả:contentReference[oaicite:6]{index=6},
   hợp đồng Muaban:contentReference[oaicite:7]{index=7}:contentReference[oaicite:8]{index=8} và VIN:contentReference[oaicite:9]{index=9}.
   ========================================================================== */

/* =========================== 0) CẤU HÌNH ============================ */
// Địa chỉ & ABI (đúng như mô tả):contentReference[oaicite:10]{index=10}
const MUABAN_ADDR = "0x190FD18820498872354eED9C4C080cB365Cd12E0"; // Muaban (VIC)
const VIN_ADDR    = "0x941F63807401efCE8afe3C9d88d368bAA287Fac4"; // VIN (VIC)

// Endpoint giá: VIC/USDT (Binance), USDT/VND (CoinGecko)
const BINANCE_VICUSDT = "https://api.binance.com/api/v3/ticker/price?symbol=VICUSDT";
const COINGECKO_USDT_VND = "https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=vnd";

// Chain Viction
const VIC_CHAIN_ID_HEX = "0x58"; // 88 decimal

// Liên kết explorer (user yêu cầu vicscan.xyz):contentReference[oaicite:11]{index=11}
const EXPLORER = "https://www.vicscan.xyz";

/* ======================= 1) BIẾN TOÀN CỤC & TIỆN ÍCH ======================= */
let provider, signer, account;
let muaban, vin;
let MUABAN_ABI, VIN_ABI;

const $  = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const byId = (id) => document.getElementById(id);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const shortAddr = (a) => a ? (a.slice(0,6) + "…" + a.slice(-4)) : "";
const toBN = ethers.BigNumber.from;

function setHidden(el, yes=true){ el.classList.toggle("hidden", !!yes); }

function toast(msg){
  // Có thể thay bằng UI đẹp hơn; hiện dùng alert đơn giản cho chắc chắn
  alert(msg);
}

/* ================ 2) TẢI ABI (đọc từ file JSON bên cạnh) ================== */
async function loadABIs(){
  if (!MUABAN_ABI) MUABAN_ABI = await (await fetch("Muaban_ABI.json", {cache:"no-store"})).json();
  if (!VIN_ABI)     VIN_ABI    = await (await fetch("VinToken_ABI.json", {cache:"no-store"})).json();
}

/* ==================== 3) GIÁ VIN/VND (theo mô tả) ==================== */
/*
  VIN/VND = (VIC/USDT từ Binance × 100) × (USDT/VND từ CoinGecko)  :contentReference[oaicite:12]{index=12}
  - Làm tròn xuống số nguyên để hiển thị (UI):contentReference[oaicite:13]{index=13}
  - Giao dịch tính vinPerVND theo precision 1e18 (VIN wei / 1 VND)
    -> vinPerVND = ceil(1e18 / vinVND)
*/
let cachePrice = { vinVnd: 0, ts: 0 };

async function fetchVinVnd(){
  const now = Date.now();
  if (cachePrice.vinVnd && now - cachePrice.ts < 45_000) return cachePrice.vinVnd;

  try{
    const vicRes = await fetch(BINANCE_VICUSDT, {cache:"no-store"});
    const vicJson = await vicRes.json();
    const vicUSDT = parseFloat(vicJson?.price || "0");

    const usdRes = await fetch(COINGECKO_USDT_VND, {cache:"no-store"});
    const usdJson = await usdRes.json();
    const usdtVnd = Number(usdJson?.tether?.vnd || 0);

    if (!vicUSDT || !usdtVnd) throw new Error("Price API error");
    const vinVnd = Math.floor(vicUSDT * 100 * usdtVnd); // int
    cachePrice = { vinVnd, ts: now };
    return vinVnd;
  }catch(e){
    console.warn("fetchVinVnd error:", e);
    return 0;
  }
}

function calcVinPerVndWei(vinVndInt){
  // ceil(1e18 / vinVnd)
  const ONE = toBN("1000000000000000000");
  const v = toBN(String(vinVndInt));
  if (v.isZero()) return toBN(0);
  return ONE.add(v).sub(1).div(v);
}

async function updatePriceChip(){
  const chip = byId("vinPrice");
  chip.textContent = "Loading price...";
  const vinVnd = await fetchVinVnd();
  chip.textContent = vinVnd ? `1 VIN = ${vinVnd.toLocaleString("vi-VN")} VND` : "Không lấy được giá";
}

/* ====================== 4) KẾT NỐI VÍ & KIỂM TRA CHUỖI ====================== */
async function ensureViction(){
  const eth = window.ethereum;
  if (!eth) throw new Error("NO_METAMASK");
  const chainId = await eth.request({ method: "eth_chainId" });
  if (chainId !== VIC_CHAIN_ID_HEX){
    try{
      await eth.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: VIC_CHAIN_ID_HEX }]
      });
    }catch(switchErr){
      // Nếu chưa có mạng, yêu cầu add
      if (switchErr.code === 4902){
        await eth.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: VIC_CHAIN_ID_HEX,
            chainName: "Viction Mainnet",
            nativeCurrency: { name: "VIC", symbol: "VIC", decimals: 18 },
            rpcUrls: ["https://rpc.viction.xyz"],
            blockExplorerUrls: ["https://scan.viction.xyz"]
          }]
        });
      }else{
        throw switchErr;
      }
    }
  }
}

async function connectWallet(){
  try{
    await ensureViction();

    await loadABIs();
    provider = new ethers.providers.Web3Provider(window.ethereum);
    await provider.send("eth_requestAccounts", []);
    signer = provider.getSigner();
    account = await signer.getAddress();

    muaban = new ethers.Contract(MUABAN_ADDR, MUABAN_ABI, signer);
    vin    = new ethers.Contract(VIN_ADDR,    VIN_ABI,    signer);

    // UI đầu header
    setHidden(byId("btnConnect"), true);
    setHidden(byId("walletBox"), false);
    const a = byId("accountShort");
    a.textContent = shortAddr(account);
    a.href = `${EXPLORER}/address/${account}`;

    // Balances
    await refreshBalances();

    // Trạng thái đăng ký
    const reg = await muaban.registered(account); // mapping public:contentReference[oaicite:14]{index=14}:contentReference[oaicite:15]{index=15}
    setHidden(byId("btnRegister"), !!reg);
    setHidden(byId("btnCreate"), !reg);
    setHidden(byId("btnOrdersBuy"), !reg);
    setHidden(byId("btnOrdersSell"), !reg);

    // Nạp sản phẩm
    await loadAllProducts();

  }catch(e){
    console.error("connectWallet error", e);
    toast("Kết nối ví thất bại. Hãy kiểm tra MetaMask & mạng Viction.");
  }
}

async function refreshBalances(){
  if (!vin || !provider || !account) return;
  try{
    const [vinBal, vicBal] = await Promise.all([
      vin.balanceOf(account),
      provider.getBalance(account)
    ]);
    // Hiển thị 4 số thập phân như yêu cầu trước đây
    byId("vinBalance").textContent = `VIN: ${ethers.utils.formatUnits(vinBal,18).slice(0,6)}`;
    byId("vicBalance").textContent = `VIC: ${parseFloat(ethers.utils.formatEther(vicBal)).toFixed(4)}`;
  }catch(e){
    console.warn("refreshBalances error:", e);
  }
}

byId("btnConnect").addEventListener("click", connectWallet);
byId("btnDisconnect").addEventListener("click", () => location.reload());

/* ========================== 5) ĐĂNG KÝ VÍ ========================== */
/*
  - Phí đăng ký REG_FEE = 0.001 VIN:contentReference[oaicite:16]{index=16}:contentReference[oaicite:17]{index=17}.
  - Quy trình: nếu allowance < phí → approve; sau đó gọi payRegistration().
*/
byId("btnRegister").addEventListener("click", onRegister);

async function onRegister(){
  try{
    if (!muaban || !vin) await connectWallet();
    const fee = await muaban.REG_FEE(); // 1e15 wei VIN:contentReference[oaicite:18]{index=18}:contentReference[oaicite:19]{index=19}
    const allowance = await vin.allowance(account, MUABAN_ADDR);
    if (allowance.lt(fee)){
      const tx1 = await vin.approve(MUABAN_ADDR, fee);
      await tx1.wait();
    }
    const tx2 = await muaban.payRegistration();
    await tx2.wait();

    toast("Đăng ký ví thành công!");
    setHidden(byId("btnRegister"), true);
    setHidden(byId("btnCreate"), false);
    setHidden(byId("btnOrdersBuy"), false);
    setHidden(byId("btnOrdersSell"), false);
  }catch(e){
    console.error("payRegistration error:", e);
    toast("Đăng ký thất bại. Hãy kiểm tra số dư VIN & cho phép (approve).");
  }finally{
    refreshBalances();
  }
}

/* ===================== 6) PARSE/RENDER SẢN PHẨM ====================== */
/*
  Hợp đồng không có hàm trả toàn bộ danh sách sản phẩm,
  ta "quét dải ID" tăng dần, dừng khi gặp nhiều PID trống liên tiếp.
  - getProduct(pid) → seller==0 thì coi như trống:contentReference[oaicite:20]{index=20}:contentReference[oaicite:21]{index=21}
*/
const productCache = new Map(); // pid -> product

function parseUnitFromDescCID(desc){
  // Mặc định mô tả lưu "unit:<...>" theo mô tả:contentReference[oaicite:22]{index=22}
  if (!desc) return "";
  const m = /^unit:(.+)$/i.exec(desc.trim());
  return m ? m[1].trim() : "";
}

function productCardHTML(p){
  const pid  = Number(p.productId);
  const unit = parseUnitFromDescCID(p.descriptionCID);
  const price = Number(p.priceVND);
  const active = !!p.active;

  const thumb = p.imageCID?.startsWith("ipfs://")
    ? `https://ipfs.io/ipfs/${p.imageCID.replace("ipfs://","")}`
    : p.imageCID;

  const sellerShort = shortAddr(p.seller);
  const me = account?.toLowerCase() === p.seller.toLowerCase();

  // Quy tắc hiển thị theo mô tả:contentReference[oaicite:23]{index=23}:
  // - Buyer: nút "Mua" khi sản phẩm còn hàng (active==true)
  // - Seller: nút "Cập nhật sản phẩm"
  const buyBtn   = active && !me ? `<button class="btn primary" data-act="buy" data-pid="${pid}">Mua</button>` : "";
  const updBtn   = me ? `<button class="btn" data-act="update" data-pid="${pid}">Cập nhật sản phẩm</button>` : "";
  const stockCls = active ? "stock-badge" : "stock-badge out";
  const stockTxt = active ? "Còn hàng" : "Hết hàng";

  return `
    <article class="product-card" data-pid="${pid}">
      <img class="product-thumb" src="${thumb || "https://ipfs.io/ipfs"}" alt="">
      <div class="product-info">
        <div class="product-top">
          <h3 class="product-title">${escapeHTML(p.name || "Sản phẩm")}</h3>
          <span class="${stockCls}">${stockTxt}</span>
        </div>
        <div class="product-meta">
          <span class="price-vnd">${price.toLocaleString("vi-VN")} VND</span>
          ${unit ? `<span class="unit">/ ${escapeHTML(unit)}</span>` : ""}
        </div>
        <div class="product-meta">
          <span class="mono">Seller: <a href="${EXPLORER}/address/${p.seller}" target="_blank" rel="noopener">${sellerShort}</a></span>
          <span class="badge">PID: ${pid}</span>
        </div>
        <div class="card-actions">
          ${buyBtn}
          ${updBtn}
          <a class="btn" href="${thumb || "#"}" target="_blank" rel="noopener">Xem ảnh/video</a>
        </div>
      </div>
    </article>
  `;
}

function escapeHTML(s){
  return (s||"").replace(/[&<>"']/g, c => (
    { "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]
  ));
}

async function loadAllProducts(){
  const list = byId("productList");
  list.innerHTML = `<p>Đang tải sản phẩm…</p>`;

  // Quét dải PID: 1..MAX_SCAN; dừng khi gặp chuỗi trống liên tiếp dài
  const MAX_SCAN = 600;          // có thể tăng tùy quy mô
  const MAX_EMPTY_STREAK = 30;   // dừng sớm nếu nhiều trống liên tiếp

  let html = "";
  let emptyStreak = 0;

  for (let pid = 1; pid <= MAX_SCAN; pid++){
    try{
      const p = await muaban.getProduct(pid); // struct Product:contentReference[oaicite:24]{index=24}:contentReference[oaicite:25]{index=25}
      if (!p || !p.seller || p.seller === ethers.constants.AddressZero){
        emptyStreak++;
        if (emptyStreak >= MAX_EMPTY_STREAK) break;
        continue;
      }
      emptyStreak = 0;
      productCache.set(pid, p);
      html += productCardHTML(p);
    }catch(e){
      // đọc lỗi → coi như trống
      emptyStreak++;
      if (emptyStreak >= MAX_EMPTY_STREAK) break;
    }
  }

  list.innerHTML = html || `<p>(Chưa có sản phẩm nào)</p>`;
}

/* ================ 7) TÌM KIẾM (lọc trên danh sách đã tải) ================= */
byId("btnSearch").addEventListener("click", applySearch);
byId("searchInput").addEventListener("keydown", (e)=>{ if(e.key==="Enter") applySearch(); });

function applySearch(){
  const q = byId("searchInput").value.trim().toLowerCase();
  const list = byId("productList");
  if (!q){
    // render lại tất cả
    let html = "";
    for (const [,p] of productCache) html += productCardHTML(p);
    list.innerHTML = html || `<p>(Chưa có sản phẩm nào)</p>`;
    return;
  }
  let html = "";
  for (const [,p] of productCache){
    if ((p.name||"").toLowerCase().includes(q)) html += productCardHTML(p);
  }
  list.innerHTML = html || `<p>Không tìm thấy sản phẩm phù hợp.</p>`;
}

/* =================== 8) MODAL: ĐĂNG SẢN PHẨM (CREATE) =================== */
byId("btnCreate").addEventListener("click", ()=>{
  setHidden(byId("formCreate"), false);
  document.body.classList.add("no-scroll");
});
$$("#formCreate .close").forEach(btn=>{
  btn.addEventListener("click", ()=>{
    setHidden(byId("formCreate"), true);
    document.body.classList.remove("no-scroll");
  });
});

byId("btnSubmitCreate").addEventListener("click", submitCreate);

async function submitCreate(){
  try{
    if (!muaban) await connectWallet();

    const name  = byId("createName").value.trim();
    const ipfs  = byId("createIPFS").value.trim();
    const unit  = byId("createUnit").value.trim();
    const price = Math.max(1, Number(byId("createPrice").value||0));
    const wallet= byId("createWallet").value.trim();
    const days  = Math.max(1, Number(byId("createDays").value||0));

    if (!name || !ipfs || !unit || !price || !wallet || !days){
      toast("Vui lòng nhập đủ thông tin.");
      return;
    }

    // Theo hợp đồng: createProduct(name, descriptionCID, imageCID, priceVND, deliveryDaysMax, payoutWallet, active):contentReference[oaicite:26]{index=26}:contentReference[oaicite:27]{index=27}
    const descriptionCID = `unit:${unit}`;
    const imageCID = ipfs;
    const active = true;

    const tx = await muaban.createProduct(
      name, descriptionCID, imageCID,
      ethers.BigNumber.from(String(price)), // priceVND integer
      days, wallet, active
    );
    await tx.wait();

    toast("Đăng sản phẩm thành công.");
    setHidden(byId("formCreate"), true);
    document.body.classList.remove("no-scroll");
    await loadAllProducts();

  }catch(e){
    console.error("submitCreate error:", e);
    // Thường "Internal JSON-RPC error." là do tham số sai kiểu hoặc thiếu đăng ký
    toast("Đăng sản phẩm thất bại. Hãy chắc chắn đã Đăng ký ví & điền đúng dữ liệu.");
  }
}

/* =================== 9) MODAL: CẬP NHẬT SẢN PHẨM (UPDATE) =================== */
document.addEventListener("click", (e)=>{
  const btn = e.target.closest("[data-act='update']");
  if (!btn) return;
  const pid = Number(btn.getAttribute("data-pid"));
  openUpdateModal(pid);
});

function fillUpdateModal(p){
  byId("updatePid").value = String(p.productId);
  byId("updatePrice").value = String(p.priceVND);
  byId("updateDays").value  = String(p.deliveryDaysMax);
  byId("updateWallet").value= p.payoutWallet;
  byId("updateActive").checked = !!p.active;
}

async function openUpdateModal(pid){
  try{
    const p = productCache.get(pid) || await muaban.getProduct(pid);
    if (!p || !p.seller || p.seller === ethers.constants.AddressZero){
      toast("Sản phẩm không tồn tại.");
      return;
    }
    const me = account && account.toLowerCase() === p.seller.toLowerCase();
    if (!me){
      toast("Chỉ người bán mới có quyền cập nhật sản phẩm này.");
      return;
    }
    fillUpdateModal(p);
    setHidden(byId("formUpdate"), false);
    document.body.classList.add("no-scroll");
  }catch(e){
    console.error("openUpdateModal error:", e);
  }
}

$$("#formUpdate .close").forEach(btn=>{
  btn.addEventListener("click", ()=>{
    setHidden(byId("formUpdate"), true);
    document.body.classList.remove("no-scroll");
  });
});

byId("btnSubmitUpdate").addEventListener("click", submitUpdate);

async function submitUpdate(){
  try{
    if (!muaban) await connectWallet();

    const pid    = Number(byId("updatePid").value);
    const price  = Math.max(1, Number(byId("updatePrice").value||0));
    const days   = Math.max(1, Number(byId("updateDays").value||0));
    const wallet = byId("updateWallet").value.trim();
    const active = byId("updateActive").checked;

    if (!pid || !price || !days || !wallet){
      toast("Vui lòng điền đủ thông tin cập nhật.");
      return;
    }

    // updateProduct(pid, priceVND, deliveryDaysMax, payoutWallet, active):contentReference[oaicite:28]{index=28}:contentReference[oaicite:29]{index=29}
    const tx = await muaban.updateProduct(
      pid,
      ethers.BigNumber.from(String(price)),
      days,
      wallet,
      active
    );
    await tx.wait();

    toast("Cập nhật sản phẩm thành công.");
    setHidden(byId("formUpdate"), true);
    document.body.classList.remove("no-scroll");

    // cập nhật cache & re-render
    const pNew = await muaban.getProduct(pid);
    productCache.set(pid, pNew);
    applySearch(); // render lại theo filter hiện tại

  }catch(e){
    console.error("submitUpdate error:", e);
    toast("Cập nhật thất bại (kiểm tra bạn có phải seller & dữ liệu hợp lệ).");
  }
}

/* =================== 10) MODAL: MUA HÀNG (BUY) =================== */
// Mở form mua với thông tin sản phẩm, tính Tổng VIN động
document.addEventListener("click", async (e)=>{
  const btn = e.target.closest("[data-act='buy']");
  if (!btn) return;
  const pid = Number(btn.getAttribute("data-pid"));
  await openBuyModal(pid);
});

let currentBuyPID = null;

async function openBuyModal(pid){
  try{
    const p = productCache.get(pid) || await muaban.getProduct(pid);
    if (!p || !p.seller || p.seller === ethers.constants.AddressZero){
      toast("Sản phẩm không tồn tại.");
      return;
    }
    if (!p.active){ toast("Sản phẩm đã tạm hết hàng."); return; }

    currentBuyPID = pid;

    // Hiển thị tóm tắt sản phẩm
    const unit = parseUnitFromDescCID(p.descriptionCID);
    const brief = `
      <div><strong>${escapeHTML(p.name)}</strong></div>
      <div>${Number(p.priceVND).toLocaleString("vi-VN")} VND ${unit?("/ "+escapeHTML(unit)):""}</div>
      <div>Giao hàng tối đa: ${p.deliveryDaysMax} ngày</div>
    `;
    byId("buyProductInfo").innerHTML = brief;

    byId("buyQty").value = "1";
    byId("buyName").value = "";
    byId("buyAddress").value = "";
    byId("buyPhone").value = "";
    byId("buyNote").value = "";

    await updateBuyTotalVIN();

    setHidden(byId("formBuy"), false);
    document.body.classList.add("no-scroll");
  }catch(e){
    console.error("openBuyModal error:", e);
  }
}

$$("#formBuy .close").forEach(btn=>{
  btn.addEventListener("click", ()=>{
    setHidden(byId("formBuy"), true);
    document.body.classList.remove("no-scroll");
  });
});

byId("buyQty").addEventListener("input", updateBuyTotalVIN);

async function updateBuyTotalVIN(){
  try{
    if (!currentBuyPID) return;
    const p = productCache.get(currentBuyPID) || await muaban.getProduct(currentBuyPID);
    const qty = Math.max(1, Number(byId("buyQty").value||1));
    const vinVnd = await fetchVinVnd();
    const vinPerVnd = calcVinPerVndWei(vinVnd);

    const totalVND = toBN(String(p.priceVND)).mul(qty);
    const totalVinWei = totalVND.mul(vinPerVnd); // ceil sẽ được xử lý trong hợp đồng bằng _ceilDiv:contentReference[oaicite:30]{index=30}
    const totalVin = ethers.utils.formatUnits(totalVinWei, 18);

    byId("buyTotalVIN").textContent = `Tổng VIN cần trả (ước tính): ${Number(totalVin).toFixed(6)} VIN`;
  }catch(e){
    console.warn("updateBuyTotalVIN error:", e);
  }
}

// Nút Mua (submit placeOrder)
byId("btnSubmitBuy").addEventListener("click", submitBuy);

function simpleEncryptForDemo(obj){
  // DEMO "mã hóa": base64 JSON để tránh plaintext dễ đọc.
  // Thực tế nên dùng khóa công khai của seller để mã hóa bất đối xứng (ngoài phạm vi yêu cầu).
  const s = JSON.stringify(obj||{});
  return btoa(unescape(encodeURIComponent(s)));
}

async function submitBuy(){
  try{
    if (!muaban || !vin) await connectWallet();
    if (!currentBuyPID){ toast("Thiếu mã sản phẩm."); return; }

    const name  = byId("buyName").value.trim();
    const addr  = byId("buyAddress").value.trim();
    const phone = byId("buyPhone").value.trim();
    const note  = byId("buyNote").value.trim();
    const qty   = Math.max(1, Number(byId("buyQty").value||1));

    if (!name || !addr){
      toast("Vui lòng nhập Họ tên & Địa chỉ.");
      return;
    }

    const infoCipher = simpleEncryptForDemo({name,addr,phone,note});

    // Tính vinPerVND (wei/1VND)
    const vinVnd = await fetchVinVnd();
    if (!vinVnd){ toast("Không lấy được giá để quy đổi."); return; }
    const vinPerVnd = calcVinPerVndWei(vinVnd);

    // ƯỚC TÍNH số VIN cần approve (tính dư 1% để tránh thiếu do ceilDiv phía contract):contentReference[oaicite:31]{index=31}
    const p = productCache.get(currentBuyPID) || await muaban.getProduct(currentBuyPID);
    const totalVND = toBN(String(p.priceVND)).mul(qty);
    const estVin = totalVND.mul(vinPerVnd);
    const estWithBuffer = estVin.mul(101).div(100); // +1%

    // Approve nếu thiếu
    const allowance = await vin.allowance(account, MUABAN_ADDR);
    if (allowance.lt(estWithBuffer)){
      const tx1 = await vin.approve(MUABAN_ADDR, estWithBuffer);
      await tx1.wait();
    }

    // placeOrder(productId, quantity, vinPerVND, buyerInfoCipher):contentReference[oaicite:32]{index=32}:contentReference[oaicite:33]{index=33}
    const tx = await muaban.placeOrder(currentBuyPID, qty, vinPerVnd, infoCipher);
    await tx.wait();

    toast("Đặt mua thành công. VIN đã được ký gửi trong hợp đồng.");
    setHidden(byId("formBuy"), true);
    document.body.classList.remove("no-scroll");
    await refreshBalances();

  }catch(e){
    console.error("submitBuy error:", e);
    toast("Mua thất bại. Kiểm tra số dư VIN & lại thử.");
  }
}

/* ==================== 11) ĐƠN HÀNG MUA & BÁN (VIEW) ==================== */
/*
  Hợp đồng cung cấp getOrder(oid) nhưng không có liệt kê toàn bộ oid:contentReference[oaicite:34]{index=34}:contentReference[oaicite:35]{index=35}.
  Chiến lược tạm thời: quét oid tương tự sản phẩm. Chỉ hiển thị đơn liên quan đến tài khoản.
*/
byId("btnOrdersBuy").addEventListener("click", renderOrdersBuy);
byId("btnOrdersSell").addEventListener("click", renderOrdersSell);

async function scanOrdersMyRelated(){
  const MAX_SCAN = 1000;
  const MAX_EMPTY_STREAK = 40;

  const myBuy = [];
  const mySell = [];

  let empty = 0;
  for (let oid=1; oid<=MAX_SCAN; oid++){
    try{
      const o = await muaban.getOrder(oid); // struct Order:contentReference[oaicite:36]{index=36}:contentReference[oaicite:37]{index=37}
      if (!o || !o.orderId || toBN(o.orderId).isZero()){
        empty++;
        if (empty >= MAX_EMPTY_STREAK) break;
        continue;
      }
      empty = 0;
      // Lọc theo account
      if (account){
        if (o.buyer && o.buyer.toLowerCase() === account.toLowerCase()) myBuy.push(o);
        if (o.seller && o.seller.toLowerCase() === account.toLowerCase()) mySell.push(o);
      }
    }catch(e){
      empty++;
      if (empty >= MAX_EMPTY_STREAK) break;
    }
  }
  return { myBuy, mySell };
}

function orderRowHTML(o){
  const statusMap = ["NONE","PLACED","RELEASED","REFUNDED"];
  const st = statusMap[Number(o.status)||0] || String(o.status);
  const vin = Number(ethers.utils.formatUnits(o.vinAmount,18)).toFixed(6);
  const linkBuyer = `${EXPLORER}/address/${o.buyer}`;
  const linkSeller = `${EXPLORER}/address/${o.seller}`;
  return `
    <div class="order-card" data-oid="${o.orderId}">
      <div class="order-row"><span class="order-strong">OID:</span> #${o.orderId}</div>
      <div class="order-row"><span class="order-strong">PID:</span> ${o.productId}</div>
      <div class="order-row">
        <span class="order-strong">Buyer:</span> <a class="mono" href="${linkBuyer}" target="_blank" rel="noopener">${shortAddr(o.buyer)}</a>
        <span class="order-strong">Seller:</span> <a class="mono" href="${linkSeller}" target="_blank" rel="noopener">${shortAddr(o.seller)}</a>
      </div>
      <div class="order-row"><span class="order-strong">Qty:</span> ${o.quantity}</div>
      <div class="order-row"><span class="order-strong">VIN ký gửi:</span> ${vin} VIN</div>
      <div class="order-row"><span class="order-strong">Trạng thái:</span> ${st}</div>
      <div class="card-actions">
        ${st==="PLACED" && account && o.buyer.toLowerCase()===account.toLowerCase()
          ? `<button class="btn primary" data-act="confirm" data-oid="${o.orderId}">Xác nhận đã nhận hàng</button>
             <button class="btn" data-act="refund" data-oid="${o.orderId}">Hoàn tiền khi quá hạn</button>`
          : ""
        }
      </div>
    </div>
  `;
}

async function renderOrdersBuy(){
  try{
    const secBuy  = byId("ordersBuySection");
    const secSell = byId("ordersSellSection");
    setHidden(secSell, true);
    setHidden(secBuy, false);

    const { myBuy } = await scanOrdersMyRelated();
    const list = byId("ordersBuyList");
    list.innerHTML = myBuy.length ? myBuy.map(orderRowHTML).join("") : `<p>(Chưa có đơn mua)</p>`;
    // Cuộn tới vùng đơn để dễ thấy
    secBuy.scrollIntoView({ behavior: "smooth", block: "start" });
  }catch(e){
    console.error("renderOrdersBuy error:", e);
  }
}

async function renderOrdersSell(){
  try{
    const secBuy  = byId("ordersBuySection");
    const secSell = byId("ordersSellSection");
    setHidden(secBuy, true);
    setHidden(secSell, false);

    const { mySell } = await scanOrdersMyRelated();
    const list = byId("ordersSellList");
    list.innerHTML = mySell.length ? mySell.map(orderRowHTML).join("") : `<p>(Chưa có đơn bán)</p>`;
    secSell.scrollIntoView({ behavior: "smooth", block: "start" });
  }catch(e){
    console.error("renderOrdersSell error:", e);
  }
}

/* ===== 12) HÀNH ĐỘNG TRÊN ĐƠN: XÁC NHẬN NHẬN HÀNG / HOÀN TIỀN ===== */
document.addEventListener("click", async (e)=>{
  const confirmBtn = e.target.closest("[data-act='confirm']");
  const refundBtn  = e.target.closest("[data-act='refund']");
  if (confirmBtn){
    const oid = Number(confirmBtn.getAttribute("data-oid"));
    await onConfirmReceipt(oid);
  }else if (refundBtn){
    const oid = Number(refundBtn.getAttribute("data-oid"));
    await onRefund(oid);
  }
});

async function onConfirmReceipt(oid){
  try{
    if (!muaban) await connectWallet();
    const tx = await muaban.confirmReceipt(oid); // chuyển VIN cho seller:contentReference[oaicite:38]{index=38}:contentReference[oaicite:39]{index=39}
    await tx.wait();
    toast("Đã xác nhận nhận hàng. VIN đã giải ngân cho người bán.");
    await refreshBalances();
    await renderOrdersBuy();
  }catch(e){
    console.error("confirmReceipt error:", e);
    toast("Xác nhận thất bại.");
  }
}

async function onRefund(oid){
  try{
    if (!muaban) await connectWallet();
    const tx = await muaban.refundIfExpired(oid); // hoàn VIN về buyer nếu quá hạn:contentReference[oaicite:40]{index=40}:contentReference[oaicite:41]{index=41}
    await tx.wait();
    toast("Yêu cầu hoàn tiền đã thực hiện (nếu đơn quá hạn).");
    await refreshBalances();
    await renderOrdersBuy();
  }catch(e){
    console.error("refundIfExpired error:", e);
    toast("Hoàn tiền thất bại (có thể chưa quá hạn).");
  }
}

/* =================== 13) LẮNG NGHE SỰ KIỆN METAMASK =================== */
if (window.ethereum){
  window.ethereum.on?.("accountsChanged", ()=>location.reload());
  window.ethereum.on?.("chainChanged", ()=>location.reload());
}

/* ========================= 14) KHỞI ĐỘNG UI ========================= */
window.addEventListener("load", async ()=>{
  await updatePriceChip();
  // Auto refresh price
  setInterval(updatePriceChip, 60000);

  // Nếu ví đã kết nối trước đó (MetaMask) → gợi ý kết nối lại
  // (MetaMask không cho tự động kết nối; user bấm "Kết nối ví")
});

/* =========================== HẾT FILE app.js =========================== */
