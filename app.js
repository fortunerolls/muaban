/* ==========================================================================
   Muaban.vin — app.js (FINAL)
   - Bảo đảm MetaMask hỏi mật khẩu khi ví đang khóa (unlock prompt)
   - Luôn HIỆN 3 nút: Đăng sản phẩm, Đơn hàng mua, Đơn hàng bán sau khi kết nối
     + Nếu CHƯA đăng ký: disable & nhắc đăng ký
     + Nếu ĐÃ đăng ký: enable đầy đủ
   - Đồng bộ với index.html/style.css【14】【18】, mô tả & hướng dẫn【15】,
     hợp đồng Muaban (Sol + ABI)【16】【17】 và VIN ABI【19】.
   ========================================================================== */

/* =========================== 0) CẤU HÌNH ============================ */
const MUABAN_ADDR = "0x190FD18820498872354eED9C4C080cB365Cd12E0"; // Muaban (VIC)【15】
const VIN_ADDR    = "0x941F63807401efCE8afe3C9d88d368bAA287Fac4"; // VIN (VIC)【15】

const BINANCE_VICUSDT     = "https://api.binance.com/api/v3/ticker/price?symbol=VICUSDT";
const COINGECKO_USDT_VND  = "https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=vnd";

const VIC_CHAIN_ID_HEX = "0x58"; // 88
const EXPLORER = "https://www.vicscan.xyz";

/* ======================= 1) BIẾN & TIỆN ÍCH ======================= */
let provider, signer, account;
let muaban, vin;
let MUABAN_ABI, VIN_ABI;

const $  = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const byId = (id) => document.getElementById(id);

const BN = (x) => ethers.BigNumber.from(String(x));
const short = (a) => a ? a.slice(0,6) + "…" + a.slice(-4) : "";
const show  = (el) => el.classList.remove("hidden");
const hide  = (el) => el.classList.add("hidden");
const setHidden = (el, yes=true) => el.classList.toggle("hidden", !!yes);
const toast = (m) => alert(m);

function escapeHTML(s){
  return (s||"").replace(/[&<>"']/g, c=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}

/* ==================== 2) TẢI ABI ==================== */
async function loadABIs(){
  if (!MUABAN_ABI) MUABAN_ABI = await (await fetch("Muaban_ABI.json", {cache:"no-store"})).json();
  if (!VIN_ABI)     VIN_ABI    = await (await fetch("VinToken_ABI.json", {cache:"no-store"})).json();
}

/* ==================== 3) GIÁ VIN/VND (theo mô tả) ==================== */
/*
  VIN/VND = (VIC/USDT từ Binance × 100) × (USDT/VND từ CoinGecko)【15】
  vinPerVND (wei/1VND) = ceil(1e18 / vinVNDInt) — phía contract cũng ceilDiv khi tính tổng【16】【17】
*/
let priceCache = { ts:0, vinVnd:0 };

async function fetchVinVnd(){
  const now = Date.now();
  if (priceCache.vinVnd && now - priceCache.ts < 45000) return priceCache.vinVnd;
  try{
    const vic = await (await fetch(BINANCE_VICUSDT, {cache:"no-store"})).json();
    const vicUSDT = parseFloat(vic?.price || "0");
    const usd = await (await fetch(COINGECKO_USDT_VND, {cache:"no-store"})).json();
    const usdtVnd = Number(usd?.tether?.vnd || 0);
    const vinVnd = Math.floor(vicUSDT * 100 * usdtVnd);
    priceCache = { ts: now, vinVnd };
    return vinVnd;
  }catch(e){
    console.warn("fetchVinVnd error:", e);
    return 0;
  }
}
function vinPerVndWei(vinVndInt){
  const ONE = ethers.constants.WeiPerEther; // 1e18
  const v = BN(vinVndInt);
  if (v.isZero()) return BN(0);
  return ONE.add(v).sub(1).div(v); // ceil(1e18 / v)
}
async function updatePriceChip(){
  const el = byId("vinPrice");
  el.textContent = "Loading price...";
  const vinVnd = await fetchVinVnd();
  el.textContent = vinVnd ? `1 VIN = ${vinVnd.toLocaleString("vi-VN")} VND` : "Không lấy được giá";
}

/* =========== 4) ĐẢM BẢO GỌI ĐƯỢC HỘP THOẠI UNLOCK CỦA METAMASK =========== */
/*
  - Bước 1: gọi eth_requestAccounts → luôn kích hoạt UI MetaMask (kể cả khi ví đang khóa)
  - Fallback: wallet_requestPermissions nếu bị treo/đã có pending request (-32002)
  - Sau khi unlock xong mới switch chain (wallet_switchEthereumChain / add chain)
*/
async function requestAccountsWithPrompt(){
  const eth = window.ethereum;
  if (!eth) throw new Error("NO_METAMASK");
  try{
    const accs = await eth.request({ method: "eth_requestAccounts" });
    if (accs && accs.length) return accs;
  }catch(e){
    // -32002: request already pending
    if (e && e.code === -32002){
      toast("MetaMask đang yêu cầu ở cửa sổ trình duyệt. Vui lòng mở và xác nhận.");
      throw e;
    }
    // user rejected (4001) → ném lỗi ra ngoài
    throw e;
  }

  // Fallback permission flow
  try{
    await eth.request({
      method: "wallet_requestPermissions",
      params: [{ eth_accounts: {} }]
    });
    const accs2 = await eth.request({ method: "eth_requestAccounts" });
    if (accs2 && accs2.length) return accs2;
  }catch(e){
    throw e;
  }
  throw new Error("UNABLE_TO_GET_ACCOUNTS");
}

async function ensureVictionAfterUnlock(){
  const eth = window.ethereum;
  const chainId = await eth.request({ method: "eth_chainId" });
  if (chainId === VIC_CHAIN_ID_HEX) return;

  try{
    await eth.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: VIC_CHAIN_ID_HEX }]
    });
  }catch(err){
    if (err && err.code === 4902){
      await eth.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: VIC_CHAIN_ID_HEX,
          chainName: "Viction Mainnet",
          nativeCurrency: { name:"VIC", symbol:"VIC", decimals:18 },
          rpcUrls: ["https://rpc.viction.xyz"],
          blockExplorerUrls: ["https://vicscan.xyz"]
        }]
      });
    }else{
      throw err;
    }
  }
}

/* ====================== 5) KẾT NỐI VÍ (có unlock) ====================== */
async function connectWallet(){
  try{
    await loadABIs();

    // 5.1 Gọi unlock prompt
    await requestAccountsWithPrompt();

    // 5.2 Switch chain sau khi đã unlock
    await ensureVictionAfterUnlock();

    // 5.3 Khởi tạo provider/signer/contracts
    provider = new ethers.providers.Web3Provider(window.ethereum);
    signer   = provider.getSigner();
    account  = await signer.getAddress();

    muaban = new ethers.Contract(MUABAN_ADDR, MUABAN_ABI, signer);
    vin    = new ethers.Contract(VIN_ADDR,    VIN_ABI,    signer);

    // 5.4 Cập nhật header
    hide(byId("btnConnect"));
    show(byId("walletBox"));
    const a = byId("accountShort");
    a.textContent = short(account);
    a.href = `${EXPLORER}/address/${account}`;

    await refreshBalances();

    // 5.5 Hiện menu sau khi KẾT NỐI (luôn hiện 3 nút như yêu cầu)
    await showMenuAfterConnect();

    // 5.6 Tải sản phẩm
    await loadAllProducts();

  }catch(e){
    console.error("connectWallet error:", e);
    toast("Không kết nối được ví. Hãy kiểm tra MetaMask & thử lại.");
  }
}
byId("btnConnect").addEventListener("click", connectWallet);
byId("btnDisconnect").addEventListener("click", ()=>location.reload());

/* ====================== 6) MENU SAU KHI KẾT NỐI ====================== */
/*
  YÊU CẦU: luôn thấy 3 nút sau khi kết nối; nếu chưa đăng ký thì disable.
*/
async function isRegistered(){
  try{
    return await muaban.registered(account); // mapping public【16】【17】
  }catch(e){
    console.warn("registered() error:", e);
    return false;
  }
}
function setMenuState(connected, registered){
  const menu = byId("menuBox");
  setHidden(menu, !connected);

  // Đăng ký button
  setHidden(byId("btnRegister"), !!registered);

  // 3 nút luôn HIỆN sau khi kết nối; bật/tắt theo registered
  ["btnCreate","btnOrdersBuy","btnOrdersSell"].forEach(id=>{
    const el = byId(id);
    setHidden(el, !connected);         // show when connected
    el.disabled = !registered;         // lock if not registered
    el.dataset.needsReg = (!registered).toString();
  });
}
async function showMenuAfterConnect(){
  const reg = await isRegistered();
  setMenuState(true, reg);
}

/* ====================== 7) ĐĂNG KÝ VÍ ====================== */
/*
  Quy trình: nếu allowance < REG_FEE → approve → payRegistration()
  REG_FEE = 0.001 VIN (1e15 wei)【16】【17】
*/
byId("btnRegister").addEventListener("click", onRegister);
async function onRegister(){
  try{
    const fee = await muaban.REG_FEE();
    const allowance = await vin.allowance(account, MUABAN_ADDR);
    if (allowance.lt(fee)){
      const tx1 = await vin.approve(MUABAN_ADDR, fee);
      await tx1.wait();
    }
    const tx2 = await muaban.payRegistration();
    await tx2.wait();

    toast("Đăng ký thành công!");
    setMenuState(true, true);
  }catch(e){
    console.error("payRegistration error:", e);
    toast("Đăng ký thất bại. Kiểm tra số dư VIN và thử lại.");
  }finally{
    refreshBalances();
  }
}

/* ====================== 8) SỐ DƯ ====================== */
async function refreshBalances(){
  if (!vin || !provider || !account) return;
  try{
    const [vinBal, vicBal] = await Promise.all([
      vin.balanceOf(account),
      provider.getBalance(account)
    ]);
    byId("vinBalance").textContent = `VIN: ${ethers.utils.formatUnits(vinBal,18).slice(0,6)}`;
    byId("vicBalance").textContent = `VIC: ${parseFloat(ethers.utils.formatEther(vicBal)).toFixed(4)}`;
  }catch(e){
    console.warn("refreshBalances error:", e);
  }
}

/* ====================== 9) SẢN PHẨM: RENDER & TÌM KIẾM ====================== */
/*
  Hợp đồng có getProduct(pid) nhưng không trả list; ta quét dải PID.
  createProduct(...) / updateProduct(...) như ABI【16】【17】.
*/
const productCache = new Map();

function unitFromDesc(desc){
  if (!desc) return "";
  const m = /^unit:(.+)$/i.exec(desc.trim());
  return m ? m[1].trim() : "";
}
function productCardHTML(p){
  const pid  = Number(p.productId);
  const unit = unitFromDesc(p.descriptionCID);
  const price = Number(p.priceVND);
  const active = !!p.active;

  const thumb = p.imageCID?.startsWith("ipfs://")
    ? `https://ipfs.io/ipfs/${p.imageCID.replace("ipfs://","")}`
    : p.imageCID;

  const sellerShort = short(p.seller);
  const me = account && p.seller && (account.toLowerCase() === p.seller.toLowerCase());
  const stockCls = active ? "stock-badge" : "stock-badge out";
  const stockTxt = active ? "Còn hàng" : "Hết hàng";

  const buyBtn = active && !me ? `<button class="btn primary" data-act="buy" data-pid="${pid}">Mua</button>` : "";
  const updBtn = me ? `<button class="btn" data-act="update" data-pid="${pid}">Cập nhật sản phẩm</button>` : "";

  return `
    <article class="product-card" data-pid="${pid}">
      <img class="product-thumb" src="${thumb || ""}" alt="">
      <div class="product-info">
        <div class="product-top">
          <h3 class="product-title">${escapeHTML(p.name||"Sản phẩm")}</h3>
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
          ${thumb ? `<a class="btn" href="${thumb}" target="_blank" rel="noopener">Xem ảnh/video</a>` : ""}
        </div>
      </div>
    </article>
  `;
}

async function loadAllProducts(){
  const list = byId("productList");
  list.innerHTML = `<p>Đang tải sản phẩm…</p>`;
  const MAX_SCAN = 600;
  const MAX_EMPTY = 30;
  let html = "", empty = 0;

  for (let pid=1; pid<=MAX_SCAN; pid++){
    try{
      const p = await muaban.getProduct(pid); // struct Product【16】【17】
      if (!p || !p.seller || p.seller === ethers.constants.AddressZero){
        empty++; if (empty>=MAX_EMPTY) break; else continue;
      }
      empty=0;
      productCache.set(pid, p);
      html += productCardHTML(p);
    }catch{
      empty++; if (empty>=MAX_EMPTY) break;
    }
  }
  list.innerHTML = html || `<p>(Chưa có sản phẩm nào)</p>`;
}

byId("btnSearch").addEventListener("click", onSearch);
byId("searchInput").addEventListener("keydown", (e)=>{ if(e.key==="Enter") onSearch(); });
function onSearch(){
  const q = byId("searchInput").value.trim().toLowerCase();
  const list = byId("productList");
  if (!q){
    let html = ""; for (const [,p] of productCache) html += productCardHTML(p);
    list.innerHTML = html || `<p>(Chưa có sản phẩm nào)</p>`;
    return;
  }
  let html = "";
  for (const [,p] of productCache){
    if ((p.name||"").toLowerCase().includes(q)) html += productCardHTML(p);
  }
  list.innerHTML = html || `<p>Không tìm thấy sản phẩm phù hợp.</p>`;
}

/* ====================== 10) CREATE PRODUCT ====================== */
byId("btnCreate").addEventListener("click", ()=>{
  // Nếu CHƯA đăng ký → nhắc
  if (byId("btnCreate").dataset.needsReg === "true"){
    toast("Bạn cần Đăng ký (0.001 VIN) trước khi đăng sản phẩm.");
    return;
  }
  show(byId("formCreate"));
  document.body.classList.add("no-scroll");
});
$$("#formCreate .close").forEach(btn=>{
  btn.addEventListener("click", ()=>{
    hide(byId("formCreate"));
    document.body.classList.remove("no-scroll");
  });
});
byId("btnSubmitCreate").addEventListener("click", submitCreate);

async function submitCreate(){
  try{
    const name  = byId("createName").value.trim();
    const ipfs  = byId("createIPFS").value.trim();
    const unit  = byId("createUnit").value.trim();
    const price = Math.max(1, Number(byId("createPrice").value||0));
    const wallet= byId("createWallet").value.trim();
    const days  = Math.max(1, Number(byId("createDays").value||0));
    if (!name || !ipfs || !unit || !price || !wallet || !days){
      toast("Vui lòng nhập đủ thông tin."); return;
    }

    // Hợp đồng: createProduct(name, descriptionCID, imageCID, priceVND, deliveryDaysMax, payoutWallet, active)【16】【17】
    const descCID = `unit:${unit}`;
    const tx = await muaban.createProduct(
      name, descCID, ipfs, BN(price), days, wallet, true
    );
    await tx.wait();

    toast("Đăng sản phẩm thành công.");
    hide(byId("formCreate"));
    document.body.classList.remove("no-scroll");
    await loadAllProducts();
  }catch(e){
    console.error("createProduct error:", e);
    toast("Đăng sản phẩm thất bại. (Kiểm tra đã Đăng ký & dữ liệu hợp lệ)");
  }
}

/* ====================== 11) UPDATE PRODUCT ====================== */
document.addEventListener("click", (e)=>{
  const btn = e.target.closest("[data-act='update']");
  if (!btn) return;
  const pid = Number(btn.getAttribute("data-pid"));
  openUpdateModal(pid);
});
$$("#formUpdate .close").forEach(btn=>{
  btn.addEventListener("click", ()=>{
    hide(byId("formUpdate"));
    document.body.classList.remove("no-scroll");
  });
});
byId("btnSubmitUpdate").addEventListener("click", submitUpdate);

function fillUpdateModal(p){
  byId("updatePid").value     = String(p.productId);
  byId("updatePrice").value   = String(p.priceVND);
  byId("updateDays").value    = String(p.deliveryDaysMax);
  byId("updateWallet").value  = p.payoutWallet;
  byId("updateActive").checked= !!p.active;
}
async function openUpdateModal(pid){
  try{
    const p = productCache.get(pid) || await muaban.getProduct(pid);
    if (!p || !p.seller || p.seller === ethers.constants.AddressZero){ toast("Sản phẩm không tồn tại."); return; }
    if (!account || p.seller.toLowerCase() !== account.toLowerCase()){ toast("Chỉ seller mới được cập nhật."); return; }
    fillUpdateModal(p);
    show(byId("formUpdate"));
    document.body.classList.add("no-scroll");
  }catch(e){
    console.error("openUpdateModal error:", e);
  }
}
async function submitUpdate(){
  try{
    const pid    = Number(byId("updatePid").value);
    const price  = Math.max(1, Number(byId("updatePrice").value||0));
    const days   = Math.max(1, Number(byId("updateDays").value||0));
    const wallet = byId("updateWallet").value.trim();
    const active = byId("updateActive").checked;
    if (!pid || !price || !days || !wallet){ toast("Điền đủ thông tin."); return; }

    // updateProduct(pid, priceVND, deliveryDaysMax, payoutWallet, active)【16】【17】
    const tx = await muaban.updateProduct(pid, BN(price), days, wallet, active);
    await tx.wait();

    toast("Cập nhật thành công.");
    hide(byId("formUpdate"));
    document.body.classList.remove("no-scroll");
    const pNew = await muaban.getProduct(pid);
    productCache.set(pid, pNew);
    onSearch(); // render lại theo filter
  }catch(e){
    console.error("submitUpdate error:", e);
    toast("Cập nhật thất bại.");
  }
}

/* ====================== 12) BUY (MUA HÀNG) ====================== */
document.addEventListener("click", async (e)=>{
  const btn = e.target.closest("[data-act='buy']");
  if (!btn) return;

  // Nếu CHƯA đăng ký → nhắc
  const needReg = byId("btnCreate").dataset.needsReg === "true";
  if (needReg){ toast("Bạn cần Đăng ký (0.001 VIN) trước khi mua."); return; }

  const pid = Number(btn.getAttribute("data-pid"));
  await openBuyModal(pid);
});

$$("#formBuy .close").forEach(btn=>{
  btn.addEventListener("click", ()=>{
    hide(byId("formBuy"));
    document.body.classList.remove("no-scroll");
  });
});
byId("buyQty").addEventListener("input", updateBuyTotalVIN);
byId("btnSubmitBuy").addEventListener("click", submitBuy);

let currentBuyPID = null;

function demoEncrypt(obj){
  const s = JSON.stringify(obj||{});
  return btoa(unescape(encodeURIComponent(s))); // base64 demo
}

async function openBuyModal(pid){
  try{
    const p = productCache.get(pid) || await muaban.getProduct(pid);
    if (!p || !p.seller || p.seller === ethers.constants.AddressZero){ toast("Sản phẩm không tồn tại."); return; }
    if (!p.active){ toast("Sản phẩm tạm hết hàng."); return; }

    currentBuyPID = pid;

    const unit = unitFromDesc(p.descriptionCID);
    byId("buyProductInfo").innerHTML = `
      <div><strong>${escapeHTML(p.name)}</strong></div>
      <div>${Number(p.priceVND).toLocaleString("vi-VN")} VND ${unit?("/ "+escapeHTML(unit)):""}</div>
      <div>Giao hàng tối đa: ${p.deliveryDaysMax} ngày</div>
    `;
    byId("buyName").value = "";
    byId("buyAddress").value = "";
    byId("buyPhone").value = "";
    byId("buyNote").value = "";
    byId("buyQty").value = "1";

    await updateBuyTotalVIN();

    show(byId("formBuy"));
    document.body.classList.add("no-scroll");
  }catch(e){
    console.error("openBuyModal error:", e);
  }
}
async function updateBuyTotalVIN(){
  try{
    if (!currentBuyPID) return;
    const p = productCache.get(currentBuyPID) || await muaban.getProduct(currentBuyPID);
    const qty = Math.max(1, Number(byId("buyQty").value||1));
    const vinVnd = await fetchVinVnd();
    const per = vinPerVndWei(vinVnd);
    const totalVND = BN(p.priceVND).mul(qty);
    const estWei = totalVND.mul(per); // contract còn ceilDiv bảo vệ seller【16】
    const estVin = Number(ethers.utils.formatUnits(estWei, 18));
    byId("buyTotalVIN").textContent = `Tổng VIN cần trả (ước tính): ${estVin.toFixed(6)} VIN`;
  }catch(e){
    console.warn("updateBuyTotalVIN error:", e);
  }
}
async function submitBuy(){
  try{
    const name  = byId("buyName").value.trim();
    const addr  = byId("buyAddress").value.trim();
    const phone = byId("buyPhone").value.trim();
    const note  = byId("buyNote").value.trim();
    const qty   = Math.max(1, Number(byId("buyQty").value||1));
    if (!name || !addr){ toast("Vui lòng nhập Họ tên & Địa chỉ."); return; }

    const infoCipher = demoEncrypt({name,addr,phone,note});
    const vinVnd = await fetchVinVnd();
    if (!vinVnd){ toast("Không lấy được giá quy đổi."); return; }
    const per = vinPerVndWei(vinVnd);

    // Ước tính & approve dư 1%
    const p = productCache.get(currentBuyPID) || await muaban.getProduct(currentBuyPID);
    const est = BN(p.priceVND).mul(qty).mul(per);
    const need = est.mul(101).div(100);

    const allowance = await vin.allowance(account, MUABAN_ADDR);
    if (allowance.lt(need)){
      const tx1 = await vin.approve(MUABAN_ADDR, need);
      await tx1.wait();
    }

    // placeOrder(productId, quantity, vinPerVND, buyerInfoCipher)【16】【17】
    const tx = await muaban.placeOrder(currentBuyPID, qty, per, infoCipher);
    await tx.wait();

    toast("Đặt mua thành công. VIN đã ký gửi trong hợp đồng.");
    hide(byId("formBuy"));
    document.body.classList.remove("no-scroll");
    await refreshBalances();
  }catch(e){
    console.error("submitBuy error:", e);
    toast("Mua thất bại. Kiểm tra số dư VIN & thử lại.");
  }
}

/* ====================== 13) ĐƠN HÀNG MUA/BÁN ====================== */
byId("btnOrdersBuy").addEventListener("click", async ()=>{
  if (byId("btnOrdersBuy").dataset.needsReg === "true"){ toast("Hãy Đăng ký trước."); return; }
  await renderOrdersBuy();
});
byId("btnOrdersSell").addEventListener("click", async ()=>{
  if (byId("btnOrdersSell").dataset.needsReg === "true"){ toast("Hãy Đăng ký trước."); return; }
  await renderOrdersSell();
});

async function scanMyOrders(){
  const MAX_SCAN = 1000, MAX_EMPTY = 40;
  const mineBuy=[], mineSell=[];
  let empty=0;
  for (let oid=1; oid<=MAX_SCAN; oid++){
    try{
      const o = await muaban.getOrder(oid); // struct Order【16】【17】
      if (!o || !o.orderId || BN(o.orderId).isZero()){ empty++; if(empty>=MAX_EMPTY) break; else continue; }
      empty=0;
      if (o.buyer && o.buyer.toLowerCase()===account.toLowerCase()) mineBuy.push(o);
      if (o.seller&& o.seller.toLowerCase()===account.toLowerCase()) mineSell.push(o);
    }catch{ empty++; if (empty>=MAX_EMPTY) break; }
  }
  return { mineBuy, mineSell };
}
function orderRowHTML(o){
  const stL = ["NONE","PLACED","RELEASED","REFUNDED"];
  const st  = stL[Number(o.status)||0] || String(o.status);
  const vin = Number(ethers.utils.formatUnits(o.vinAmount,18)).toFixed(6);
  return `
    <div class="order-card" data-oid="${o.orderId}">
      <div class="order-row"><span class="order-strong">OID:</span> #${o.orderId}</div>
      <div class="order-row"><span class="order-strong">PID:</span> ${o.productId}</div>
      <div class="order-row">
        <span class="order-strong">Buyer:</span> <a class="mono" href="${EXPLORER}/address/${o.buyer}" target="_blank" rel="noopener">${short(o.buyer)}</a>
        <span class="order-strong">Seller:</span> <a class="mono" href="${EXPLORER}/address/${o.seller}" target="_blank" rel="noopener">${short(o.seller)}</a>
      </div>
      <div class="order-row"><span class="order-strong">Qty:</span> ${o.quantity}</div>
      <div class="order-row"><span class="order-strong">VIN ký gửi:</span> ${vin} VIN</div>
      <div class="order-row"><span class="order-strong">Trạng thái:</span> ${st}</div>
      <div class="card-actions">
        ${st==="PLACED" && account && o.buyer.toLowerCase()===account.toLowerCase()
          ? `<button class="btn primary" data-act="confirm" data-oid="${o.orderId}">Xác nhận đã nhận hàng</button>
             <button class="btn" data-act="refund" data-oid="${o.orderId}">Hoàn tiền khi quá hạn</button>`
          : ""}
      </div>
    </div>
  `;
}
async function renderOrdersBuy(){
  const sec = byId("ordersBuySection"), other = byId("ordersSellSection");
  hide(other); show(sec);
  const { mineBuy } = await scanMyOrders();
  byId("ordersBuyList").innerHTML = mineBuy.length ? mineBuy.map(orderRowHTML).join("") : `<p>(Chưa có đơn mua)</p>`;
  sec.scrollIntoView({behavior:"smooth", block:"start"});
}
async function renderOrdersSell(){
  const sec = byId("ordersSellSection"), other = byId("ordersBuySection");
  hide(other); show(sec);
  const { mineSell } = await scanMyOrders();
  byId("ordersSellList").innerHTML = mineSell.length ? mineSell.map(orderRowHTML).join("") : `<p>(Chưa có đơn bán)</p>`;
  sec.scrollIntoView({behavior:"smooth", block:"start"});
}

/* ====================== 14) HÀNH ĐỘNG TRÊN ĐƠN ====================== */
document.addEventListener("click", async (e)=>{
  const cBtn = e.target.closest("[data-act='confirm']");
  const rBtn = e.target.closest("[data-act='refund']");
  if (cBtn){
    try{
      const oid = Number(cBtn.getAttribute("data-oid"));
      const tx = await muaban.confirmReceipt(oid); // giải ngân VIN cho seller【16】【17】
      await tx.wait();
      toast("Đã xác nhận nhận hàng.");
      await renderOrdersBuy();
      await refreshBalances();
    }catch(err){
      console.error("confirmReceipt error:", err);
      toast("Xác nhận thất bại.");
    }
  }else if (rBtn){
    try{
      const oid = Number(rBtn.getAttribute("data-oid"));
      const tx = await muaban.refundIfExpired(oid); // hoàn VIN nếu quá hạn【16】【17】
      await tx.wait();
      toast("Yêu cầu hoàn tiền đã thực hiện (nếu đơn quá hạn).");
      await renderOrdersBuy();
      await refreshBalances();
    }catch(err){
      console.error("refundIfExpired error:", err);
      toast("Hoàn tiền thất bại (có thể chưa quá hạn).");
    }
  }
});

/* ====================== 15) SỰ KIỆN METAMASK ====================== */
if (window.ethereum){
  window.ethereum.on?.("accountsChanged", ()=>location.reload());
  window.ethereum.on?.("chainChanged",   ()=>location.reload());
}

/* ====================== 16) KHỞI ĐỘNG UI ====================== */
window.addEventListener("load", async ()=>{
  await updatePriceChip();
  setInterval(updatePriceChip, 60000);
});
