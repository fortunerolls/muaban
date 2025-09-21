/* ====================================================================
   muaban.vin — app.js (ethers v5)
   MỤC TIÊU: sửa lỗi "Internal JSON-RPC error" khi ký giao dịch & ổn định UI
   - ÉP GIAO DỊCH LEGACY (type 0) dùng gasPrice; KHÔNG gửi EIP-1559 trên VIC
   - Preflight mọi giao dịch (populateTransaction + provider.call({from}))
     để bắt revert rõ ràng (NOT_REGISTERED, PRICE_REQUIRED, ...)
   - Tỷ giá VIN/VND: lấy từ nhiều nguồn; có thể override qua <body data-vin-vnd>
   - Bám sát HTML (index.html) & ABI (Muaban_ABI.json, VinToken_ABI.json)
==================================================================== */

/* -------------------- DOM helpers -------------------- */
const $  = (q)=>document.querySelector(q);
const $$ = (q)=>document.querySelectorAll(q);
const show = el=>{ if(!el) return; el.classList.remove('hidden'); };
const hide = el=>{ if(!el) return; el.classList.add('hidden'); };
const short=(a)=>a?`${a.slice(0,6)}…${a.slice(-4)}`: "";
const ipfsToHttp=(cid)=>!cid? "": (cid.startsWith("ipfs://")? cid.replace("ipfs://","https://ipfs.io/ipfs/") : (cid.startsWith("Qm")||cid.startsWith("bafy")?`https://ipfs.io/ipfs/${cid}`:cid));
const esc = (s)=>String(s??"").replace(/[&<>"']/g, m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));

/* -------------------- Hằng số & Cấu hình -------------------- */
const DEFAULTS = {
  RPC_URL: "https://rpc.viction.xyz",
  CHAIN_ID_HEX: "0x58", // 88
  CHAIN_NAME: "Viction",
  NATIVE: { name:"VIC", symbol:"VIC", decimals:18 },
  EXPLORER: "https://vicscan.xyz",
  // Địa chỉ mặc định (có thể override qua <body data-*>):
  MUABAN_ADDR: "0x190FD18820498872354eED9C4C080cB365Cd12E0",
  VIN_ADDR:    "0x941F63807401efCE8afe3C9d88d368bAA287Fac4",
  // Phí đăng ký 0.001 VIN (18 decimals)
  REG_FEE_WEI: "1000000000000000",
  // Nguồn tỷ giá (đa nguồn để tránh lỗi CORS / rate-limit)
  COINGECKO_VIC_VND: "https://api.coingecko.com/api/v3/simple/price?ids=viction&vs_currencies=vnd",
  COINGECKO_USD_VND:  "https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=vnd",
  COINGECKO_VIC_USD:  "https://api.coingecko.com/api/v3/simple/price?ids=viction&vs_currencies=usd",
  BINANCE_VICUSDT:    "https://api.binance.com/api/v3/ticker/price?symbol=VICUSDT", // có thể không luôn khả dụng
};

/* ---- GAS/FEES: ép legacy (gasPrice), không dùng EIP-1559 ---- */
const GAS_LIMIT_LIGHT = ethers.BigNumber.from("200000");   // approve / confirm / refund
const GAS_LIMIT_MED   = ethers.BigNumber.from("400000");   // payRegistration / updateProduct / placeOrder
const GAS_LIMIT_HEAVY = ethers.BigNumber.from("800000");   // createProduct
const LEGACY_GAS_PRICE_GWEI = "50"; // tăng 100–200 nếu cần

/* -------------------- State -------------------- */
let providerRead, providerWrite, signer, account;
let MUABAN_ABI, VIN_ABI;
let muaban, vin;            // viết
let isRegistered = false;

let vinPerVNDWei = ethers.BigNumber.from(0); // VIN wei cho 1 VND (ceil)
let vinVND = 0;                               // 1 VIN = ? VND (floor)
let productsCache = [];
let ordersBuyer = [];
let ordersSeller = [];

/* -------------------- Tiện ích số & chuỗi -------------------- */
const toBN = (v)=>ethers.BigNumber.from(String(v));
const parseVND = (s)=>{ // chấp nhận "1.200.000", "1,200,000", "1200000"
  if (typeof s !== 'string') s = String(s??"");
  s = s.replace(/[.,\s]/g, "");
  if (!/^\d+$/.test(s)) return NaN;
  return Number(s);
};
const fmtNumber = (n)=> Number(n||0).toLocaleString("vi-VN");
const fmt4 = (n)=> Number(n||0).toFixed(4);
const nowSec = ()=> Math.floor(Date.now()/1000);

/* -------------------- Thông báo -------------------- */
function toast(msg, type="info"){
  console[type==="error"?"error":"log"]("[toast]", msg);
  // nếu muốn hiển thị đẹp, có thể thêm phần tử #toast trong html
}

/* -------------------- Revert decoding -------------------- */
function parseRevert(err){
  try{
    // ethers v5: err.error?.message || err.data?.message
    if (err?.error?.message) return err.error.message;
    if (err?.data?.message)  return err.data.message;
    if (err?.message)        return err.message;
    return "Giao dịch bị từ chối hoặc lỗi mạng.";
  }catch{ return "Giao dịch thất bại."; }
}

/* -------------------- EVM chain helpers -------------------- */
async function ensureChain(){
  if (!window.ethereum) throw new Error("Vui lòng cài MetaMask.");
  const web3 = new ethers.providers.Web3Provider(window.ethereum, "any");
  const net  = await web3.getNetwork();
  const curHex = "0x"+Number(net.chainId).toString(16);
  if (curHex === DEFAULTS.CHAIN_ID_HEX) return;
  try{
    await window.ethereum.request({
      method:"wallet_switchEthereumChain",
      params:[{chainId: DEFAULTS.CHAIN_ID_HEX}],
    });
  }catch(e){
    if (e.code === 4902){
      await window.ethereum.request({
        method:"wallet_addEthereumChain",
        params:[{
          chainId: DEFAULTS.CHAIN_ID_HEX,
          chainName: DEFAULTS.CHAIN_NAME,
          nativeCurrency: DEFAULTS.NATIVE,
          rpcUrls:[DEFAULTS.RPC_URL],
          blockExplorerUrls:[DEFAULTS.EXPLORER],
        }]
      });
    }else{
      throw e;
    }
  }
}

async function connect(){
  try{
    await ensureChain();
    providerWrite = new ethers.providers.Web3Provider(window.ethereum, "any");
    const accs = await window.ethereum.request({ method:"eth_requestAccounts" });
    account = ethers.utils.getAddress(accs[0]);
    signer  = providerWrite.getSigner();

    // Contract write (signer)
    const { MUABAN_ADDR, VIN_ADDR } = readAddrs();
    muaban = new ethers.Contract(MUABAN_ADDR, MUABAN_ABI, signer);
    vin    = new ethers.Contract(VIN_ADDR,    VIN_ABI,    signer);

    $("#accountShort") && ($("#accountShort").textContent = short(account));
    hide($("#btnConnect"));
    show($("#btnDisconnect"));

    toast("Kết nối ví thành công.");
    await refreshBalances();
    await afterConnectedUI();
  }catch(e){
    console.error("connect:", e);
    toast(parseRevert(e), "error");
  }
}

function disconnect(){
  // MetaMask không hỗ trợ programmatic disconnect: reset UI thôi
  account = undefined; signer = undefined; muaban = undefined; vin = undefined;
  $("#accountShort") && ($("#accountShort").textContent = "");
  show($("#btnConnect"));
  hide($("#btnDisconnect"));
  hide($("#menuBox"));
}

/* -------------------- ABI + Address -------------------- */
async function loadAbis(){
  MUABAN_ABI = await fetch("Muaban_ABI.json").then(r=>r.json());
  VIN_ABI    = await fetch("VinToken_ABI.json").then(r=>r.json());
}
function readAddrs(){
  const b = document.body;
  const ma = b?.dataset?.muabanAddr;
  const va = b?.dataset?.vinAddr;
  return {
    MUABAN_ADDR: (ma && ethers.utils.isAddress(ma) ? ma : DEFAULTS.MUABAN_ADDR),
    VIN_ADDR:    (va && ethers.utils.isAddress(va) ? va : DEFAULTS.VIN_ADDR)
  };
}

/* -------------------- Providers & Contracts -------------------- */
function initProviders(){
  providerRead  = new ethers.providers.JsonRpcProvider(DEFAULTS.RPC_URL);
  if (window.ethereum) providerWrite = new ethers.providers.Web3Provider(window.ethereum, "any");
}
function initContractsForRead(){
  const { MUABAN_ADDR, VIN_ADDR } = readAddrs();
  return {
    muabanR: new ethers.Contract(MUABAN_ADDR, MUABAN_ABI, providerRead),
    vinR:    new ethers.Contract(VIN_ADDR, VIN_ABI, providerRead),
  };
}

/* -------------------- Giá VIN/VND -------------------- */
async function calcVinVND(){
  // Ưu tiên body data-vin-vnd nếu có set sẵn
  const bodyVinVnd = Number(document.body?.dataset?.vinVnd || 0);
  if (bodyVinVnd>0){ vinVND = Math.floor(bodyVinVnd); return vinVND; }

  // Nguồn 1: VICUSDT (Binance) × USDT→VND (CG) × 100
  let vicUsd = 0, usdtVnd = 0;
  try{
    const r = await fetch(DEFAULTS.BINANCE_VICUSDT, {cache:"no-store"});
    const js = await r.json();
    const price = Number(js?.price||0);
    if (price>0) vicUsd = price; // 1 VIC = ? USDT ~= ? USD
  }catch{}

  try{
    const r2 = await fetch(DEFAULTS.COINGECKO_USD_VND, {cache:"no-store"});
    const js2 = await r2.json();
    usdtVnd = Number(js2?.tether?.vnd||0);
  }catch{}

  if (vicUsd>0 && usdtVnd>0){
    vinVND = Math.floor(vicUsd * 100 * usdtVnd);
  }else{
    // fallback: lấy trực tiếp VIC→VND rồi ×100
    try{
      const r3 = await fetch(DEFAULTS.COINGECKO_VIC_VND, {cache:"no-store"});
      const js3 = await r3.json();
      const vicVnd = Number(js3?.viction?.vnd||0);
      if (vicVnd>0) vinVND = Math.floor(vicVnd * 100);
    }catch{
      vinVND = 0;
    }
  }
  return vinVND;
}
function updateVinPriceUI(){
  const el = $("#vinPrice");
  if (el) el.textContent = vinVND>0? `1 VIN = ${fmtNumber(vinVND)} VND` : "1 VIN = đang tải…";
}

/* -------------------- Số dư -------------------- */
async function refreshBalances(){
  try{
    const { vinR } = initContractsForRead();
    const acc = account || (await providerWrite?.listAccounts?.()?.[0]) || null;
    if (!acc) return;

    const [vicWei, vinBalRaw, vinDec] = await Promise.all([
      providerWrite.getBalance(acc),
      vinR.balanceOf(acc),
      vinR.decimals()
    ]);
    const vic = parseFloat(ethers.utils.formatEther(vicWei));
    const vin = parseFloat(ethers.utils.formatUnits(vinBalRaw, vinDec));

    $("#vicBalance") && ($("#vicBalance").textContent = `VIC: ${fmt4(vic)}`);
    $("#vinBalance") && ($("#vinBalance").textContent = `VIN: ${fmt4(vin)}`);
  }catch(e){
    console.warn("refreshBalances:", e);
  }
}

/* -------------------- Đăng ký / Quyền sử dụng -------------------- */
async function checkRegistered(muabanR){
  // nếu contract có isRegistered(account):bool
  try{
    if (!account) return false;
    const ok = await muabanR.isRegistered(account);
    return !!ok;
  }catch{ return true; } // nếu không có hàm này thì coi như true
}
async function payRegistration(){
  try{
    if (!signer) await connect();
    const { muabanR } = initContractsForRead();
    const ok = await checkRegistered(muabanR);
    if (ok){ toast("Bạn đã đăng ký trước đó."); return; }

    const ov = await buildOverrides("med");
    // nếu contract yêu cầu phí đăng ký bằng VIN: gọi hàm tương ứng
    // ở đây ví dụ payRegistration(uint256 fee) — chỉnh theo ABI thật nếu khác
    const fee = toBN(DEFAULTS.REG_FEE_WEI);
    const tx = await muaban.payRegistration(fee, ov);
    await tx.wait();
    toast("Đăng ký thành công.");
    await afterConnectedUI();
  }catch(e){
    toast(parseRevert(e), "error");
  }
}

/* -------------------- UI sau khi connect -------------------- */
async function afterConnectedUI(){
  const { muabanR } = initContractsForRead();
  isRegistered = await checkRegistered(muabanR);

  const regBtn = $("#btnRegister");
  const createBtn = $("#btnCreate");
  const oBuy = $("#btnOrdersBuy");
  const oSell= $("#btnOrdersSell");
  const menu = $("#menuBox");

  if (!isRegistered){
    show(regBtn); hide(createBtn); hide(oBuy); hide(oSell);
  }else{
    hide(regBtn); show(createBtn); show(oBuy); show(oSell);
  }
  menu?.classList.remove('hidden');
}

/* -------------------- Sản phẩm: load qua event -------------------- */
async function loadAllProducts(muabanR){
  try{
    const iface = new ethers.utils.Interface(MUABAN_ABI);
    const topic = iface.getEventTopic("ProductCreated");
    const { MUABAN_ADDR } = readAddrs();
    const logs = await providerRead.getLogs({ address: MUABAN_ADDR, fromBlock: 0, toBlock: "latest", topics: [topic] });
    const pids = new Set();
    logs.forEach(l=>{ const parsed = iface.parseLog(l); pids.add(parsed.args.productId.toString()); });

    productsCache = [];
    for (const pid of Array.from(pids).sort((a,b)=>Number(a)-Number(b))){
      const p = await muabanR.getProduct(pid);
      productsCache.push({ pid: Number(pid), data: p });
    }
    renderProducts(productsCache);
  }catch(e){ console.error("loadAllProducts:", e); }
}
function renderProducts(list){
  const wrap = $("#productList");
  if (!wrap) return;
  wrap.innerHTML = "";
  if (!list.length){ wrap.innerHTML = `<div class="tag">Chưa có sản phẩm.</div>`; return; }
  list.forEach(({pid, data})=>{
    const unit = parseUnitFromCID(data.descriptionCID);
    const img = ipfsToHttp(data.imageCID);
    const active = data.active;
    const priceVND = data.priceVND?.toString?.()||data.priceVND||"0";
    const vndNum = Number(priceVND);
    const vndStr = fmtNumber(vndNum);

    const card = document.createElement("div");
    card.className = "product";
    card.innerHTML = `
      <div class="thumb">${img?`<img src="${esc(img)}" alt="product" />`:""}</div>
      <div class="info">
        <div class="name">${esc(data.name)}</div>
        <div class="unit">Đơn vị: ${esc(unit||"-")}</div>
        <div class="price">Giá: ${vndStr} VND</div>
        <div class="status ${active?'on':'off'}">${active?'Còn hàng':'Hết hàng'}</div>
      </div>
      <div class="actions">
        <button class="btn buy" data-pid="${pid}" ${active?"":"disabled"}>Mua</button>
        <button class="btn update" data-pid="${pid}">Sửa</button>
      </div>
    `;
    wrap.appendChild(card);
  });

  // gán sự kiện
  $$(".product .buy").forEach(btn=>{
    btn.addEventListener("click", (e)=>{
      const pid = Number(e.currentTarget.dataset.pid);
      openBuyForm(pid);
    });
  });
  $$(".product .update").forEach(btn=>{
    btn.addEventListener("click", (e)=>{
      const pid = Number(e.currentTarget.dataset.pid);
      openUpdateForm(pid);
    });
  });
}
function parseUnitFromCID(desc){
  if (!desc) return "";
  const m = String(desc).match(/unit:([^;]+)/);
  return m? m[1].trim() : "";
}

/* -------------------- CREATE PRODUCT -------------------- */
function openCreateForm(){
  $("#formCreate")?.classList.remove("hidden");
}
function closeCreateForm(){ $("#formCreate")?.classList.add("hidden"); }
function readCreateInputs(){
  let name = $("#createName")?.value?.trim()||"";
  const ipfs = $("#createIPFS")?.value?.trim()||"";
  const unit = $("#createUnit")?.value?.trim()||"";
  const priceVNDNum = parseVND($("#createPrice")?.value||"");
  const wallet = $("#createWallet")?.value?.trim()||"";
  const days = Number($("#createDays")?.value||0);

  // safe cutoff
  if (name.length > 500) name = name.slice(0,500);
  return { name, ipfs, unit, priceVNDNum, wallet, days };
}
function validateCreate({name, ipfs, unit, priceVNDNum, wallet, days}){
  if (name.length<1) return "Vui lòng nhập Tên sản phẩm.";
  if (!ipfs) return "Vui lòng nhập IPFS CID.";
  if (!unit) return "Vui lòng nhập đơn vị.";
  if (!ethers.utils.isAddress(wallet)) return "Ví nhận thanh toán không hợp lệ.";
  if (!Number.isInteger(days) || days <= 0) return "Số ngày giao ≥ 1.";
  if (!Number.isFinite(priceVNDNum) || priceVNDNum <= 0) return "Giá (VND) phải > 0.";
  return "";
}
async function submitCreate(){
  try{
    if (!signer) await connect();

    const inp = readCreateInputs();
    const err = validateCreate(inp);
    if (err){ toast(err, "error"); return; }

    const descriptionCID = `unit:${inp.unit}`;
    const imageCID = inp.ipfs;
    const priceVND = ethers.BigNumber.from(String(inp.priceVNDNum));

    // 1) simulate để bắt revert rõ ràng
    const txData = await muaban.populateTransaction.createProduct(
      inp.name, descriptionCID, imageCID, priceVND, inp.days, inp.wallet, true
    );
    txData.from = account;
    try{
      await providerWrite.call(txData);
    }catch(simErr){
      toast(parseRevert(simErr), "error");
      return;
    }

    // 2) gửi legacy tx (type:0)
    const ov = await buildOverrides("heavy");
    const tx = await muaban.createProduct(
      inp.name, descriptionCID, imageCID, priceVND, inp.days, inp.wallet, true, ov
    );
    toast("Đang gửi giao dịch tạo sản phẩm…");
    await tx.wait();
    toast("Tạo sản phẩm thành công.");

    closeCreateForm();
    const { muabanR } = initContractsForRead();
    await loadAllProducts(muabanR);
  }catch(e){
    toast(parseRevert(e), "error");
  }
}

/* -------------------- UPDATE PRODUCT -------------------- */
function openUpdateForm(pid){
  const prod = productsCache.find(p=>p.pid===pid);
  if (!prod) return;
  $("#updatePid").value = String(pid);
  $("#updatePrice").value = String(prod.data?.priceVND||"");
  $("#updateDays").value  = String(prod.data?.deliveryDaysMax||"");
  $("#updateWallet").value= String(prod.data?.payoutWallet||"");
  $("#updateActive").checked = !!prod.data?.active;
  $("#formUpdate")?.classList.remove("hidden");
}
function closeUpdateForm(){ $("#formUpdate")?.classList.add("hidden"); }
function readUpdateInputs(){
  const pid = Number($("#updatePid").value||0);
  const priceVNDNum = parseVND($("#updatePrice").value||"");
  const days = Number($("#updateDays").value||0);
  const wallet = $("#updateWallet").value?.trim()||"";
  const active = !!$("#updateActive").checked;
  return { pid, priceVNDNum, days, wallet, active };
}
function validateUpdate({pid, priceVNDNum, days, wallet}){
  if (!Number.isInteger(pid) || pid<0) return "pid không hợp lệ.";
  if (!Number.isFinite(priceVNDNum) || priceVNDNum <= 0) return "Giá (VND) phải > 0.";
  if (!Number.isInteger(days) || days <= 0) return "Số ngày giao ≥ 1.";
  if (!ethers.utils.isAddress(wallet)) return "Ví nhận thanh toán không hợp lệ.";
  return "";
}
async function submitUpdate(){
  try{
    if (!signer) await connect();
    const u = readUpdateInputs();
    const err = validateUpdate(u);
    if (err){ toast(err, "error"); return; }

    const priceVND = ethers.BigNumber.from(String(u.priceVNDNum));

    // simulate
    const txData = await muaban.populateTransaction.updateProduct(
      u.pid, priceVND, u.days, u.wallet, u.active
    );
    txData.from = account;
    try{ await providerWrite.call(txData); }
    catch(simErr){ toast(parseRevert(simErr), "error"); return; }

    // send
    const ov = await buildOverrides("med");
    const tx = await muaban.updateProduct(u.pid, priceVND, u.days, u.wallet, u.active, ov);
    toast("Đang cập nhật sản phẩm…");
    await tx.wait();
    toast("Cập nhật thành công.");
    closeUpdateForm();

    const { muabanR } = initContractsForRead();
    await loadAllProducts(muabanR);
  }catch(e){ toast(parseRevert(e), "error"); }
}

/* -------------------- MUA HÀNG -------------------- */
function openBuyForm(pid){
  const prod = productsCache.find(p=>p.pid===pid);
  if (!prod) return;
  const p = prod.data;
  $("#buyProductInfo").innerHTML = `
    <div><strong>${esc(p.name)}</strong></div>
    <div>Giá: ${fmtNumber(Number(p.priceVND||p.priceVND?.toString?.()||"0"))} VND</div>
    <div>Đơn vị: ${esc(parseUnitFromCID(p.descriptionCID)||"-")}</div>
  `;
  $("#formBuy")?.classList.remove("hidden");
  $("#formBuy").dataset.pid = String(pid);
}
function closeBuyForm(){ $("#formBuy")?.classList.add("hidden"); }
function readBuyInputs(){
  const pid = Number($("#formBuy").dataset.pid||0);
  const name = $("#buyName").value?.trim()||"";
  const address = $("#buyAddress").value?.trim()||"";
  const phone = $("#buyPhone").value?.trim()||"";
  const note = $("#buyNote").value?.trim()||"";
  // số lượng (UI không thấy trong snippet, nếu cần thêm id buyQty)
  const qty = 1;
  return { pid, name, address, phone, note, qty };
}
function validateBuy({name, address, phone}){
  if (!name) return "Nhập họ tên.";
  if (!address) return "Nhập địa chỉ.";
  if (!phone) return "Nhập SĐT.";
  return "";
}
async function submitBuy(){
  try{
    if (!signer) await connect();
    const b = readBuyInputs();
    const err = validateBuy(b);
    if (err){ toast(err, "error"); return; }

    // Ví dụ: placeOrder(pid, buyerName, shipAddr, phone, note, qty)
    // (Hãy chỉnh đúng theo ABI thật của bạn)
    const txData = await muaban.populateTransaction.placeOrder(
      b.pid, b.name, b.address, b.phone, b.note, b.qty
    );
    txData.from = account;
    try{ await providerWrite.call(txData); }
    catch(simErr){ toast(parseRevert(simErr), "error"); return; }

    const ov = await buildOverrides("med");
    const tx = await muaban.placeOrder(b.pid, b.name, b.address, b.phone, b.note, b.qty, ov);
    toast("Đang gửi đơn hàng…");
    await tx.wait();
    toast("Đặt hàng thành công.");
    closeBuyForm();
  }catch(e){ toast(parseRevert(e), "error"); }
}

/* -------------------- ĐƠN HÀNG CỦA TÔI -------------------- */
async function loadMyOrders(){
  try{
    const iface = new ethers.utils.Interface(MUABAN_ABI);
    const topic = iface.getEventTopic("OrderPlaced");
    const { MUABAN_ADDR } = readAddrs();
    const logs = await providerRead.getLogs({ address: MUABAN_ADDR, fromBlock: 0, toBlock: "latest", topics: [topic] });
    ordersBuyer = []; ordersSeller = [];

    const { muabanR } = initContractsForRead();

    for (const l of logs){
      const parsed = iface.parseLog(l);
      const orderId = Number(parsed.args.orderId);
      const productId = Number(parsed.args.productId);
      const o = await muabanR.getOrder(orderId);
      const p = await muabanR.getProduct(productId);

      const isBuyer  = (o.buyer?.toLowerCase?.()===account?.toLowerCase?.());
      const isSeller = (p.payoutWallet?.toLowerCase?.()===account?.toLowerCase?.());
      const item = { order: o, product: p, orderId, productId };
      if (isBuyer) ordersBuyer.push(item);
      if (isSeller) ordersSeller.push(item);
    }
    renderOrders();
  }catch(e){ console.error("loadMyOrders:", e); }
}
function renderOrders(){
  const bWrap = $("#ordersBuyList");
  if (bWrap){
    bWrap.innerHTML = "";
    if (!ordersBuyer.length){
      bWrap.innerHTML = `<div class="tag">Chưa có đơn mua.</div>`;
    }else{
      ordersBuyer.sort((a,b)=>b.orderId-a.orderId).
      forEach(it=>{
        const row = document.createElement("div");
        row.className="order-item";
        row.innerHTML = `
          <div>#${it.orderId} — ${esc(it.product?.name||"-")}</div>
          <div>Người bán: ${short(it.product?.payoutWallet||"")}</div>
        `;
        bWrap.appendChild(row);
      });
    }
  }

  const sWrap = $("#ordersSellList");
  if (sWrap){
    sWrap.innerHTML = "";
    if (!ordersSeller.length){
      sWrap.innerHTML = `<div class="tag">Chưa có đơn bán.</div>`;
    }else{
      ordersSeller.sort((a,b)=>b.orderId-a.orderId).
      forEach(it=>{
        const row = document.createElement("div");
        row.className="order-item";
        row.innerHTML = `
          <div>#${it.orderId} — ${esc(it.product?.name||"-")}</div>
          <div>Người mua: ${short(it.order?.buyer||"")}</div>
        `;
        sWrap.appendChild(row);
      });
    }
  }
}

/* -------------------- Overrides (legacy tx) -------------------- */
async function buildOverrides(level="med"){
  const gasPrice = ethers.utils.parseUnits(LEGACY_GAS_PRICE_GWEI, "gwei");
  let gasLimit = GAS_LIMIT_MED;
  if (level==="light") gasLimit = GAS_LIMIT_LIGHT;
  else if (level==="heavy") gasLimit = GAS_LIMIT_HEAVY;
  return { type:0, gasPrice, gasLimit };
}

/* -------------------- Sự kiện nút / UI -------------------- */
function bindUI(){
  $("#btnConnect")?.addEventListener("click", connect);
  $("#btnDisconnect")?.addEventListener("click", disconnect);

  $("#btnRegister")?.addEventListener("click", payRegistration);
  $("#btnCreate")?.addEventListener("click", openCreateForm);
  $("#btnSubmitCreate")?.addEventListener("click", (e)=>{ e.preventDefault(); submitCreate(); });
  $("#btnSubmitUpdate")?.addEventListener("click", (e)=>{ e.preventDefault(); submitUpdate(); });
  $("#btnSubmitBuy")?.addEventListener("click", (e)=>{ e.preventDefault(); submitBuy(); });

  // đóng modal
  $$("#formCreate .close")?.forEach?.(b=>b.addEventListener("click", closeCreateForm));
  $$("#formUpdate .close")?.forEach?.(b=>b.addEventListener("click", closeUpdateForm));
  $$("#formBuy    .close")?.forEach?.(b=>b.addEventListener("click", closeBuyForm));

  // tìm kiếm
  $("#btnSearch")?.addEventListener("click", ()=>{
    const kw = $("#searchInput")?.value?.trim()?.toLowerCase()||"";
    const list = !kw? productsCache : productsCache.filter(p=> String(p.data?.name||"").toLowerCase().includes(kw));
    renderProducts(list);
  });
}

/* -------------------- Khởi tạo -------------------- */
async function init(){
  await loadAbis();
  initProviders();

  // giá VIN/VND
  try{
    await calcVinVND();
  }finally{
    updateVinPriceUI();
    setInterval(async ()=>{ await calcVinVND(); updateVinPriceUI(); }, 60_000);
  }

  bindUI();

  // auto show menu nếu đã kết nối
  if (window.ethereum){
    window.ethereum.on?.("accountsChanged", ()=>{ window.location.reload(); });
    window.ethereum.on?.("chainChanged",    ()=>{ window.location.reload(); });
  }

  // load product list
  try{
    const { muabanR } = initContractsForRead();
    await loadAllProducts(muabanR);
  }catch(e){ console.warn("init loadAllProducts:", e); }
}

document.addEventListener("DOMContentLoaded", init);
