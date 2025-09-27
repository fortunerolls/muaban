"use strict";

/* ====== Hằng số & cấu hình ====== */
const VIC_CHAIN_ID_DEC = 88;
const VIC_CHAIN_ID_HEX = "0x58";
const RPC_URL          = "https://rpc.viction.xyz";
const EXPLORER_ADDR    = "https://www.vicscan.xyz/address/";

const MUA_BAN_ADDR = "0x190FD18820498872354eED9C4C080cB365Cd12E0";
const VIN_ADDR     = "0x941F63807401efCE8afe3C9d88d368bAA287Fac4";

// Nguồn giá
const BINANCE_VIC_USDT   = "https://api.binance.com/api/v3/ticker/price?symbol=VICUSDT";
const COINGECKO_USDT_VND = "https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=vnd";

/* ====== DOM refs ====== */
const $connectBtn   = document.getElementById("btnConnect");
const $disconnect   = document.getElementById("btnDisconnect");
const $walletBox    = document.getElementById("walletBox");
const $vinPriceChip = document.getElementById("vinPrice");
const $vinBal       = document.getElementById("vinBalance");
const $vicBal       = document.getElementById("vicBalance");
const $acctShort    = document.getElementById("accountShort");

const $menu         = document.getElementById("menuBox");
const $btnRegister  = document.getElementById("btnRegister");
const $btnCreate    = document.getElementById("btnCreate");
const $btnOrdersBuy = document.getElementById("btnOrdersBuy");
const $btnOrdersSell= document.getElementById("btnOrdersSell");

const $searchInput  = document.getElementById("searchInput");
const $btnSearch    = document.getElementById("btnSearch");
const $productList  = document.getElementById("productList");

// Modals & inputs
const $formCreate   = document.getElementById("formCreate");
const $createName   = document.getElementById("createName");
const $createIPFS   = document.getElementById("createIPFS");
const $createUnit   = document.getElementById("createUnit");
const $createPrice  = document.getElementById("createPrice");
const $createWallet = document.getElementById("createWallet");
const $createDays   = document.getElementById("createDays");
const $btnSubmitCreate = document.getElementById("btnSubmitCreate");

const $formUpdate   = document.getElementById("formUpdate");
const $updatePid    = document.getElementById("updatePid");
const $updatePrice  = document.getElementById("updatePrice");
const $updateDays   = document.getElementById("updateDays");
const $updateWallet = document.getElementById("updateWallet");
const $updateActive = document.getElementById("updateActive");
const $btnSubmitUpdate = document.getElementById("btnSubmitUpdate");

const $formBuy      = document.getElementById("formBuy");
const $buyProductInfo = document.getElementById("buyProductInfo");
const $buyName      = document.getElementById("buyName");
const $buyAddress   = document.getElementById("buyAddress");
const $buyPhone     = document.getElementById("buyPhone");
const $buyNote      = document.getElementById("buyNote");
const $buyQty       = document.getElementById("buyQty");
const $buyTotalVIN  = document.getElementById("buyTotalVIN");
const $btnSubmitBuy = document.getElementById("btnSubmitBuy");

// Orders sections
const $ordersBuySection  = document.getElementById("ordersBuySection");
const $ordersSellSection = document.getElementById("ordersSellSection");
const $ordersBuyList     = document.getElementById("ordersBuyList");
const $ordersSellList    = document.getElementById("ordersSellList");

/* ====== State ====== */
let provider, web3Provider, signer, myAddr;
let MUABAN_ABI, VIN_ABI;
let muaban, vin;
let isRegistered = false;

let vndPerVIN = null;       // float
let vinPerVND_wei = null;   // BigNumber (VIN-wei cho 1 VND)

/* ====== Helpers UI ====== */
function short(addr){ return addr ? (addr.slice(0,6) + "…" + addr.slice(-4)) : ""; }
function fmtVND(n){ return Number(n).toLocaleString("vi-VN"); }
function fmtVIN(n){ return Number(n).toLocaleString("en-US", { maximumFractionDigits: 6 }); }
function escapeHtml(s){
  return String(s||"").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function toast(msg, type="info"){
  const el = document.createElement("div");
  el.textContent = msg;
  el.style.position="fixed"; el.style.zIndex=9999; el.style.left="50%"; el.style.top="14px";
  el.style.transform="translateX(-50%)"; el.style.padding="10px 14px"; el.style.borderRadius="10px";
  el.style.background= type==="error" ? "#fee2e2" : (type==="warn" ? "#fef9c3" : "#e0f2fe");
  el.style.border="1px solid #e5e7eb"; el.style.boxShadow="0 6px 24px rgba(2,6,23,.12)"; el.style.color="#0f172a";
  document.body.appendChild(el); setTimeout(()=> el.remove(), 3600);
}

/* ====== Modals ====== */
function openModal(el){ if(!el) return; el.classList.remove("hidden"); document.body.classList.add("no-scroll"); }
function closeModal(el){ if(!el) return; el.classList.add("hidden"); document.body.classList.remove("no-scroll"); }
document.querySelectorAll(".modal .close")?.forEach(btn => btn.addEventListener("click", ()=> closeModal(btn.closest(".modal"))));
document.querySelectorAll(".modal")?.forEach(modal=> modal.addEventListener("click", (e)=>{ if(e.target === modal) closeModal(modal); }));

/* ====== Ethers v5 init ====== */
async function ensureProviders(){
  if(window.ethereum){
    web3Provider = new ethers.providers.Web3Provider(window.ethereum, "any");
    provider     = web3Provider;
  }else{
    provider = new ethers.providers.JsonRpcProvider(RPC_URL, { chainId: VIC_CHAIN_ID_DEC, name: "Viction" });
  }
}
async function ensureVictionChain(){
  if(!window.ethereum) return true;
  const cid = await window.ethereum.request({ method:"eth_chainId" });
  if (cid === VIC_CHAIN_ID_HEX) return true;
  try{
    await window.ethereum.request({ method:"wallet_switchEthereumChain", params:[{ chainId: VIC_CHAIN_ID_HEX }] });
    return true;
  }catch(err){
    if (err && err.code === 4902){
      await window.ethereum.request({
        method:"wallet_addEthereumChain",
        params:[{ chainId: VIC_CHAIN_ID_HEX, chainName:"Viction Mainnet",
          nativeCurrency:{ name:"VIC", symbol:"VIC", decimals:18 },
          rpcUrls:[RPC_URL], blockExplorerUrls:["https://www.vicscan.xyz"] }]
      }); return true;
    }
    throw err;
  }
}

/* ====== Load ABIs & build contracts ====== */
async function loadABIs(){
  const [abiMuaban, abiVin] = await Promise.all([
    fetch("Muaban_ABI.json").then(r=>r.json()),
    fetch("VinToken_ABI.json").then(r=>r.json())
  ]);
  MUABAN_ABI = abiMuaban; VIN_ABI = abiVin;
}
function buildContracts(){
  muaban = new ethers.Contract(MUA_BAN_ADDR, MUABAN_ABI, signer || provider);
  vin    = new ethers.Contract(VIN_ADDR,     VIN_ABI,    signer || provider);
}

/* ====== Giá: 1 VIN = VIC/USDT × 100 × USDT/VND ====== */
async function refreshPrice(){
  try{
    $vinPriceChip.textContent = "Loading price...";
    const [vicRes, cgRes] = await Promise.all([
      fetch(BINANCE_VIC_USDT, { cache:"no-store" }).then(r=>r.json()),
      fetch(COINGECKO_USDT_VND, { cache:"no-store" }).then(r=>r.json())
    ]);
    const vic_usdt = Number(vicRes?.price || 0);
    const usdt_vnd = Number(cgRes?.tether?.vnd || 0);
    if(!vic_usdt || !usdt_vnd) throw new Error("Không lấy được giá VIC/USDT hoặc USDT/VND");

    vndPerVIN = vic_usdt * 100 * usdt_vnd; // số VND cho 1 VIN (float)

    // vinPerVND_wei = ceil(1e18 / vndPerVIN) an toàn big-int
    const ONE   = ethers.BigNumber.from("1000000000000000000"); // 1e18
    const SCALE = ethers.BigNumber.from("1000000");
    const scaled = Math.max(1, Math.round(vndPerVIN * 1e6));
    const vndScaled = ethers.BigNumber.from(String(scaled));
    vinPerVND_wei = ONE.mul(SCALE).add(vndScaled).sub(1).div(vndScaled);

    $vinPriceChip.textContent = `1 VIN = ${fmtVND(Math.round(vndPerVIN))} VND`;
  }catch(e){
    console.warn("refreshPrice()", e);
    $vinPriceChip.textContent = "Price unavailable";
    vinPerVND_wei = null;
  }
}

/* ====== Kết nối / Ngắt kết nối ====== */
async function connect(){
  if(!window.ethereum){ return toast("Không tìm thấy ví. Hãy cài MetaMask.", "warn"); }
  try{
    await ensureProviders(); await ensureVictionChain();
    await web3Provider.send("eth_requestAccounts", []);
    signer = web3Provider.getSigner(); myAddr = await signer.getAddress();
    buildContracts(); wireWalletUI(true);
    await Promise.all([refreshBalances(), checkRegistrationAndMenu()]);
    await loadAndRenderProducts();

    window.ethereum?.on?.("accountsChanged", ()=> location.reload());
    window.ethereum?.on?.("chainChanged", ()=> location.reload());
  }catch(err){ console.error("connect()", err); toast(parseRpcError(err), "error"); }
}
function disconnect(){ signer = undefined; myAddr = undefined; buildContracts(); wireWalletUI(false); toast("Đã ngắt kết nối."); }
function wireWalletUI(connected){
  if(connected){
    $connectBtn?.classList.add("hidden");
    $walletBox?.classList.remove("hidden");
    $acctShort.textContent = short(myAddr);
    $acctShort.href = EXPLORER_ADDR + myAddr;
  }else{
    $connectBtn?.classList.remove("hidden");
    $walletBox?.classList.add("hidden");
    $menu?.classList.add("hidden");
  }
}

/* ====== Số dư ====== */
async function refreshBalances(){
  try{
    if(!provider) await ensureProviders();
    if(!myAddr){ $vicBal.textContent = "VIC: 0"; $vinBal.textContent = "VIN: 0"; return; }
    const vicWei = await provider.getBalance(myAddr);
    $vicBal.textContent = "VIC: " + fmtVIN(ethers.utils.formatEther(vicWei));
    const vinCtr = new ethers.Contract(VIN_ADDR, VIN_ABI, signer || provider);
    const vinBal = await vinCtr.balanceOf(myAddr);
    $vinBal.textContent = "VIN: " + fmtVIN(ethers.utils.formatEther(vinBal));
  }catch(e){ console.warn("refreshBalances()", e); $vicBal.textContent = "VIC: 0"; $vinBal.textContent = "VIN: 0"; }
}

/* ====== Safe-approve pattern ====== */
async function ensureAllowance(tokenCtr, ownerAddr, spenderAddr, minAmountBN){
  const current = await tokenCtr.allowance(ownerAddr, spenderAddr);
  if (current.gte(minAmountBN)) return;
  if (current.gt(0)){ const tx0 = await tokenCtr.approve(spenderAddr, ethers.constants.Zero); toast("Đang reset allowance về 0…"); await tx0.wait(); }
  const tx = await tokenCtr.approve(spenderAddr, minAmountBN); toast("Đang approve token…"); await tx.wait();
}

/* ====== Đăng ký ví ====== */
async function handleRegister(){
  try{
    if(!signer) return toast("Hãy kết nối ví trước.", "warn");
    const regFee = await muaban.REG_FEE();
    const vinWithSigner = vin.connect(signer);
    await ensureAllowance(vinWithSigner, myAddr, MUA_BAN_ADDR, regFee);

    // Preflight: callStatic để bắt revert rõ nghĩa
    await muaban.connect(signer).callStatic.payRegistration({ gasLimit: 150000 });

    const tx2 = await muaban.connect(signer).payRegistration({ gasLimit: 150000 });
    toast("Đang đăng ký ví…"); await tx2.wait();
    toast("Đăng ký thành công!"); await checkRegistrationAndMenu(); await refreshBalances();
  }catch(err){ console.error("handleRegister()", err); toast(parseRpcError(err), "error"); }
}
async function checkRegistrationAndMenu(){
  try{
    if(!muaban) buildContracts();
    if(!myAddr){ $menu?.classList.add("hidden"); return; }
    isRegistered = await muaban.registered(myAddr);
    $menu?.classList.remove("hidden");
    if(!isRegistered){ $btnRegister?.classList.remove("hidden"); $btnCreate?.classList.add("hidden"); $btnOrdersBuy?.classList.add("hidden"); $btnOrdersSell?.classList.add("hidden"); }
    else{ $btnRegister?.classList.add("hidden"); $btnCreate?.classList.remove("hidden"); $btnOrdersBuy?.classList.remove("hidden"); $btnOrdersSell?.classList.remove("hidden"); }
  }catch(e){ console.warn("checkRegistrationAndMenu()", e); }
}

/* ====== Đăng sản phẩm ====== */
function openCreateForm(){
  if(!signer) return toast("Hãy kết nối ví trước.", "warn");
  if(!isRegistered) return toast("Bạn cần đăng ký (0.001 VIN) trước khi đăng.", "warn");
  $createName.value=""; $createIPFS.value=""; $createUnit.value=""; $createPrice.value=""; $createWallet.value= myAddr||""; $createDays.value="3";
  openModal($formCreate);
}
async function submitCreate(){
  try{
    if(!signer) return toast("Hãy kết nối ví trước.", "warn");
    const name  = ($createName.value||"").trim();
    const ipfs  = ($createIPFS.value||"").trim();
    const price = ethers.BigNumber.from(String(Math.max(1, parseInt($createPrice.value||"0",10))));
    const wallet= ($createWallet.value||"").trim();
    const days  = Math.max(1, parseInt($createDays.value||"0",10));
    if (!name) return toast("Tên sản phẩm không được trống.", "warn");
    if (!wallet || !ethers.utils.isAddress(wallet)) return toast("Ví nhận thanh toán không hợp lệ.", "warn");

    // Preflight
    await muaban.connect(signer).callStatic.createProduct(name, ipfs, ipfs, price, days, wallet, true, { gasLimit: 300000 });

    const tx = await muaban.connect(signer).createProduct(name, ipfs, ipfs, price, days, wallet, true, { gasLimit: 300000 });
    toast("Đang đăng sản phẩm…"); const rc = await tx.wait();
    let pid=null; rc?.events?.forEach(ev=>{ if(ev.event==="ProductCreated") pid = ev.args?.productId?.toString?.()||null; });
    closeModal($formCreate); toast(pid?`Đăng xong! Mã sản phẩm #${pid}`:"Đăng xong!"); await loadAndRenderProducts();
  }catch(err){ console.error("submitCreate()", err); toast(parseRpcError(err), "error"); }
}

/* ====== Cập nhật sản phẩm ====== */
function openUpdateForm(product){
  if(!signer) return toast("Hãy kết nối ví trước.", "warn");
  if(!isRegistered) return toast("Bạn cần đăng ký trước.", "warn");
  if(!product) return;
  $updatePid.value=product.productId; $updatePrice.value=product.priceVND; $updateDays.value=product.deliveryDaysMax; $updateWallet.value=product.payoutWallet; $updateActive.checked=!!product.active;
  openModal($formUpdate);
}
async function submitUpdate(){
  try{
    if(!signer) return toast("Hãy kết nối ví trước.", "warn");
    const pid   = parseInt($updatePid.value,10);
    const price = ethers.BigNumber.from(String(Math.max(1, parseInt($updatePrice.value||"0",10))));
    const days  = Math.max(1, parseInt($updateDays.value||"0",10));
    const wallet= ($updateWallet.value||"").trim();
    const active= !!$updateActive.checked;
    if(!ethers.utils.isAddress(wallet)) return toast("Ví nhận thanh toán không hợp lệ.", "warn");

    await muaban.connect(signer).callStatic.updateProduct(pid, price, days, wallet, active, { gasLimit: 250000 });

    const tx = await muaban.connect(signer).updateProduct(pid, price, days, wallet, active, { gasLimit: 250000 });
    toast("Đang cập nhật sản phẩm…"); await tx.wait(); closeModal($formUpdate); toast("Cập nhật thành công!"); await loadAndRenderProducts();
  }catch(err){ console.error("submitUpdate()", err); toast(parseRpcError(err), "error"); }
}

/* ====== Mua hàng ====== */
let currentBuyProduct = null;
function openBuyForm(product){
  if(!signer) return toast("Hãy kết nối ví trước.", "warn");
  if(!isRegistered) return toast("Bạn cần đăng ký trước.", "warn");
  if(!product?.active) return toast("Sản phẩm đang hết hàng.", "warn");
  currentBuyProduct = product;
  $buyName.value=""; $buyAddress.value=""; $buyPhone.value=""; $buyNote.value=""; $buyQty.value="1";
  $buyProductInfo.innerHTML = `
    <div class="product-brief">
      <div><b>#${product.productId}</b> — ${escapeHtml(product.name||"")}</div>
      <div class="price-vnd">Giá: ${fmtVND(product.priceVND)} VND / ${escapeHtml(product.unit||"-")}</div>
      <div>Seller: <span class="mono">${short(String(product.seller))}</span></div>
    </div>`;
  updateBuyTotal(); openModal($formBuy);
}
function updateBuyTotal(){
  const qty = Math.max(1, parseInt($buyQty.value||"1",10));
  if(!currentBuyProduct || !vndPerVIN){ $buyTotalVIN.textContent = "Tổng VIN cần trả: 0"; return; }
  const totalVND = Number(currentBuyProduct.priceVND) * qty;
  const totalVIN = totalVND / vndPerVIN; // hiển thị ước tính (on-chain đã ceil)
  $buyTotalVIN.textContent = `Tổng VIN cần trả (ước tính): ${fmtVIN(totalVIN)}`;
}
$buyQty?.addEventListener("input", updateBuyTotal);

async function submitBuy(){
  try{
    if(!signer) return toast("Hãy kết nối ví trước.", "warn");
    if(!currentBuyProduct) return;

    // Bảo đảm tỷ giá đã sẵn sàng
    if(!vinPerVND_wei){ await refreshPrice(); if(!vinPerVND_wei) throw new Error("Không tính được tỷ giá VIN/VND."); }

    const qty = Math.max(1, parseInt($buyQty.value||"1",10));
    // Thông tin buyer (mã hóa nhẹ)
    const buyerInfoObj = { name:($buyName.value||"").trim(), address:($buyAddress.value||"").trim(), phone:($buyPhone.value||"").trim(), note:($buyNote.value||"").trim(), t:Date.now() };
    let buyerInfoCipher = await encryptBuyerInfo(JSON.stringify(buyerInfoObj)).catch(()=> null);
    if(!buyerInfoCipher) buyerInfoCipher = "b64:" + btoa(JSON.stringify(buyerInfoObj));

    // Tính vinAmount để approve
    const totalVND = ethers.BigNumber.from(String(currentBuyProduct.priceVND)).mul(qty);
    const vinPerVND = ethers.BigNumber.from(vinPerVND_wei.toString());
    const vinAmount = totalVND.mul(vinPerVND);

    const vinWithSigner = vin.connect(signer);
    await ensureAllowance(vinWithSigner, myAddr, MUA_BAN_ADDR, vinAmount);

    // Preflight
    await muaban.connect(signer).callStatic.placeOrder(currentBuyProduct.productId, qty, vinPerVND, buyerInfoCipher, { gasLimit: 320000 });

    const tx2 = await muaban.connect(signer).placeOrder(currentBuyProduct.productId, qty, vinPerVND, buyerInfoCipher, { gasLimit: 320000 });
    toast("Đang tạo đơn hàng…"); const rc = await tx2.wait();
    let oid=null; rc?.events?.forEach(ev=>{ if(ev.event==="OrderPlaced") oid = ev.args?.orderId?.toString?.()||null; });
    closeModal($formBuy); toast(oid?`Đặt hàng thành công! Mã đơn #${oid}`:"Đặt hàng thành công!"); await refreshBalances();
  }catch(err){ console.error("submitBuy()", err); toast(parseRpcError(err), "error"); }
}

/* ====== Danh sách sản phẩm ====== */
async function loadAndRenderProducts(keyword=""){
  try{
    $productList.innerHTML = `<div class="tag">Đang tải sản phẩm…</div>`;
    const maxScan = 300, emptyCutoff = 20;
    let emptyRun = 0; const items = [];
    for(let pid=1; pid<=maxScan; pid++){
      try{
        const p = await muaban.getProduct(pid);
        if (!p || p.seller === ethers.constants.AddressZero){ emptyRun++; if(emptyRun >= emptyCutoff) break; continue; }
        emptyRun = 0; items.push(normalizeProduct(pid, p));
      }catch(_){ emptyRun++; if(emptyRun >= emptyCutoff) break; }
    }
    let filtered = items;
    if(keyword){ const q = keyword.toLowerCase(); filtered = items.filter(it => (it.name||"").toLowerCase().includes(q)); }
    if(!filtered.length){ $productList.innerHTML = `<div class="tag">Chưa có sản phẩm hiển thị. Hãy bấm <b>Đăng sản phẩm</b> để tạo mới.</div>`; return; }
    $productList.innerHTML = ""; filtered.forEach(prod => $productList.appendChild(renderProductCard(prod)));
  }catch(e){ console.error("loadAndRenderProducts()", e); $productList.innerHTML = `<div class="tag">Lỗi tải sản phẩm: ${escapeHtml(String(e.message||e))}</div>`; }
}
function normalizeProduct(pid, p){
  return { productId: pid, seller: p.seller, name: p.name, descriptionCID: p.descriptionCID, imageCID: p.imageCID,
    priceVND: p.priceVND?.toString?.()||"0", deliveryDaysMax: Number(p.deliveryDaysMax||0), payoutWallet: p.payoutWallet,
    active: !!p.active, createdAt: Number(p.createdAt||0), updatedAt: Number(p.updatedAt||0), unit: "" };
}
function renderProductCard(p){
  const div = document.createElement("div"); div.className = "product-card";
  const img = document.createElement("img"); img.className = "product-thumb"; img.src = ipfsToHttp(p.imageCID); img.alt = p.name || "product"; div.appendChild(img);
  const box = document.createElement("div"); box.className = "product-info"; div.appendChild(box);
  const top = document.createElement("div"); top.className = "product-top";
  const title = document.createElement("h3"); title.className = "product-title"; title.textContent = p.name || "(Không tên)";
  const stock = document.createElement("span"); stock.className = "stock-badge " + (p.active ? "" : "out"); stock.textContent = p.active ? "Còn hàng" : "Hết hàng";
  top.appendChild(title); top.appendChild(stock); box.appendChild(top);
  const meta = document.createElement("div"); meta.className = "product-meta"; meta.innerHTML = `<span class="price-vnd">${fmtVND(p.priceVND)} VND</span><span class="unit">/ ${p.unit || "-"}</span>`; box.appendChild(meta);
  const actions = document.createElement("div"); actions.className = "card-actions"; box.appendChild(actions);
  if (myAddr && myAddr.toLowerCase() === String(p.seller).toLowerCase()){
    const btnEdit = document.createElement("button"); btnEdit.className = "btn"; btnEdit.textContent = "Cập nhật sản phẩm"; btnEdit.onclick = ()=> openUpdateForm(p); actions.appendChild(btnEdit);
  }else{
    const btnBuy = document.createElement("button"); btnBuy.className = "btn primary"; btnBuy.textContent = "Mua"; btnBuy.disabled = !p.active; btnBuy.onclick = ()=> openBuyForm(p); actions.appendChild(btnBuy);
  }
  return div;
}

/* ====== Đơn hàng của tôi (placeholder) ====== */
$btnOrdersBuy?.addEventListener("click", ()=>{
  $ordersSellSection.classList.add("hidden"); $ordersBuySection.classList.remove("hidden");
  $ordersBuyList.innerHTML = `<div class="order-card">Chưa có API liệt kê “Đơn hàng mua” theo ví. Tra cứu <b>placeOrder</b> của ví bạn trên VicScan.</div>`;
});
$btnOrdersSell?.addEventListener("click", ()=>{
  $ordersBuySection.classList.add("hidden"); $ordersSellSection.classList.remove("hidden");
  $ordersSellList.innerHTML = `<div class="order-card">Chưa có API liệt kê “Đơn hàng bán” theo ví. Xem sự kiện <b>OrderPlaced</b> sản phẩm của bạn trên VicScan.</div>`;
});

/* ====== Tiện ích ====== */
function ipfsToHttp(link){ if(!link) return ""; if(link.startsWith("ipfs://")) return "https://ipfs.io/ipfs/" + link.replace("ipfs://",""); return link; }
function parseRpcError(err){
  const m = err?.data?.message || err?.error?.message || err?.message || String(err);
  if(/INSUFFICIENT_FUNDS/i.test(m)) return "Không đủ VIC để trả gas.";
  if(/NOT_REGISTERED/i.test(m))     return "Ví chưa đăng ký. Vui lòng bấm Đăng ký (0.001 VIN).";
  if(/ALREADY_REGISTERED/i.test(m)) return "Ví đã đăng ký rồi.";
  if(/PRODUCT_NOT_FOUND/i.test(m))  return "Không tìm thấy sản phẩm.";
  if(/PRODUCT_NOT_ACTIVE/i.test(m)) return "Sản phẩm đang hết hàng.";
  if(/QUANTITY_REQUIRED/i.test(m))  return "Vui lòng nhập số lượng hợp lệ.";
  if(/VIN_PER_VND_REQUIRED/i.test(m)) return "Thiếu tỷ giá VIN/VND. Thử lại sau vài giây.";
  if(/PRICE_REQUIRED|DELIVERY_REQUIRED|PAYOUT_WALLET_ZERO/i.test(m)) return "Dữ liệu sản phẩm chưa hợp lệ.";
  if(/VIN_TRANSFER_FAIL|exceeds balance/i.test(m)) return "Số dư VIN không đủ hoặc token từ chối chuyển.";
  if(/VIN_DECIMALS_MUST_BE_18/i.test(m)) return "Token VIN không đúng 18 decimals.";
  if(/user rejected transaction/i.test(m)) return "Bạn đã từ chối giao dịch.";
  if(/CHAIN|network/i.test(m)) return "Sai mạng. Hãy chuyển sang Viction.";
  return "Lỗi giao dịch: " + m;
}
async function encryptBuyerInfo(plainText){
  try{
    if(!window.crypto?.subtle) throw new Error("No SubtleCrypto");
    const rawKey = new Uint8Array(32); window.crypto.getRandomValues(rawKey);
    const key = await window.crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt"]);
    const iv  = new Uint8Array(12); window.crypto.getRandomValues(iv);
    const enc = await window.crypto.subtle.encrypt({ name:"AES-GCM", iv }, key, new TextEncoder().encode(plainText));
    const b64 = btoa(String.fromCharCode(...new Uint8Array(enc)));
    const ivb64 = btoa(String.fromCharCode(...iv));
    return `aesgcm:${ivb64}:${b64}`;
  }catch(_){ return null; }
}

/* ====== Sự kiện nút ====== */
$connectBtn?.addEventListener("click", connect);
$disconnect?.addEventListener("click", disconnect);
$btnRegister?.addEventListener("click", handleRegister);
$btnCreate?.addEventListener("click", openCreateForm);
$btnSubmitCreate?.addEventListener("click", submitCreate);
$btnSubmitUpdate?.addEventListener("click", submitUpdate);
$btnSubmitBuy?.addEventListener("click", submitBuy);
$btnSearch?.addEventListener("click", ()=> loadAndRenderProducts(($searchInput.value||"").trim()) );

/* ====== Khởi động ====== */
(async function init(){
  try{
    await ensureProviders(); await loadABIs(); buildContracts();
    refreshPrice(); setInterval(refreshPrice, 60_000);
    if(window.ethereum){
      const accs = await window.ethereum.request({ method:"eth_accounts" });
      if(accs && accs.length){ await connect(); } else { await loadAndRenderProducts(); }
    }else{ await loadAndRenderProducts(); }
  }catch(e){ console.warn("init()", e); }
})();
