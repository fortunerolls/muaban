<script>
// ===============================
// Muaban.vin — app.js (ethers v5)
// ===============================

// ====== Cấu hình nền tảng (theo mô tả/ABI/hướng dẫn) ======
const VIC = {
  CHAIN_ID_DEC: 88,
  CHAIN_ID_HEX: "0x58", // 88
  NAME: "Viction Mainnet",
  RPC: "https://rpc.viction.xyz",
  EXPL: "https://www.vicscan.xyz"
};

// Hợp đồng & Token trên VIC
const MUABAN_ADDR = "0x190FD18820498872354eED9C4C080cB365Cd12E0"; // Hợp đồng Muaban (VIC)
const VIN_ADDR     = "0x941F63807401efCE8afe3C9d88d368bAA287Fac4"; // Token VIN (VIC)

// Giá VIN/VND = (VIC/USDT từ Binance × 100) × (USDT/VND từ CoinGecko)
const BINANCE_VICUSDT = "https://api.binance.com/api/v3/ticker/price?symbol=VICUSDT";
const COINGECKO_USDT_VND = "https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=vnd";

// ====== ABI rút gọn cần dùng ======
// ERC20 (VIN): đủ cho balanceOf/allowance/approve/decimals
const ERC20_ABI = [
  {"inputs":[{"internalType":"address","name":"owner","type":"address"}],"name":"balanceOf","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
  {"inputs":[],"name":"decimals","outputs":[{"internalType":"uint8","name":"","type":"uint8"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"internalType":"address","name":"owner","type":"address"},{"internalType":"address","name":"spender","type":"address"}],"name":"allowance","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"internalType":"address","name":"spender","type":"address"},{"internalType":"uint256","name":"amount","type":"uint256"}],"name":"approve","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"}
];

// Muaban ABI (đồng bộ file Muaban_ABI.json)
const MUABAN_ABI = [
  {"inputs":[{"internalType":"address","name":"vinToken","type":"address"}],"stateMutability":"nonpayable","type":"constructor"},
  {"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint256","name":"orderId","type":"uint256"},{"indexed":true,"internalType":"uint256","name":"productId","type":"uint256"},{"indexed":true,"internalType":"address","name":"buyer","type":"address"},{"indexed":false,"internalType":"uint256","name":"quantity","type":"uint256"},{"indexed":false,"internalType":"uint256","name":"vinAmount","type":"uint256"}],"name":"OrderPlaced","type":"event"},
  {"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint256","name":"orderId","type":"uint256"},{"indexed":false,"internalType":"uint256","name":"vinAmount","type":"uint256"}],"name":"OrderRefunded","type":"event"},
  {"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint256","name":"orderId","type":"uint256"},{"indexed":false,"internalType":"uint256","name":"vinAmount","type":"uint256"}],"name":"OrderReleased","type":"event"},
  {"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint256","name":"productId","type":"uint256"},{"indexed":true,"internalType":"address","name":"seller","type":"address"},{"indexed":false,"internalType":"string","name":"name","type":"string"},{"indexed":false,"internalType":"uint256","name":"priceVND","type":"uint256"}],"name":"ProductCreated","type":"event"},
  {"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint256","name":"productId","type":"uint256"},{"indexed":false,"internalType":"uint256","name":"priceVND","type":"uint256"},{"indexed":false,"internalType":"uint32","name":"deliveryDaysMax","type":"uint32"},{"indexed":false,"internalType":"bool","name":"active","type":"bool"}],"name":"ProductUpdated","type":"event"},
  {"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"user","type":"address"}],"name":"Registered","type":"event"},
  {"inputs":[],"name":"REG_FEE","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"internalType":"uint256","name":"orderId","type":"uint256"}],"name":"confirmReceipt","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"string","name":"name","type":"string"},{"internalType":"string","name":"descriptionCID","type":"string"},{"internalType":"string","name":"imageCID","type":"string"},{"internalType":"uint256","name":"priceVND","type":"uint256"},{"internalType":"uint32","name":"deliveryDaysMax","type":"uint32"},{"internalType":"address","name":"payoutWallet","type":"address"},{"internalType":"bool","name":"active","type":"bool"}],"name":"createProduct","outputs":[{"internalType":"uint256","name":"pid","type":"uint256"}],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"uint256","name":"oid","type":"uint256"}],"name":"getOrder","outputs":[{"components":[{"internalType":"uint256","name":"orderId","type":"uint256"},{"internalType":"uint256","name":"productId","type":"uint256"},{"internalType":"address","name":"buyer","type":"address"},{"internalType":"address","name":"seller","type":"address"},{"internalType":"uint256","name":"quantity","type":"uint256"},{"internalType":"uint256","name":"vinAmount","type":"uint256"},{"internalType":"uint256","name":"placedAt","type":"uint256"},{"internalType":"uint256","name":"deadline","type":"uint256"},{"internalType":"uint8","name":"status","type":"uint8"},{"internalType":"string","name":"buyerInfoCipher","type":"string"}],"internalType":"struct MuabanVND.Order","name":"","type":"tuple"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"internalType":"uint256","name":"pid","type":"uint256"}],"name":"getProduct","outputs":[{"components":[{"internalType":"uint256","name":"productId","type":"uint256"},{"internalType":"address","name":"seller","type":"address"},{"internalType":"string","name":"name","type":"string"},{"internalType":"string","name":"descriptionCID","type":"string"},{"internalType":"string","name":"imageCID","type":"string"},{"internalType":"uint256","name":"priceVND","type":"uint256"},{"internalType":"uint32","name":"deliveryDaysMax","type":"uint32"},{"internalType":"address","name":"payoutWallet","type":"address"},{"internalType":"bool","name":"active","type":"bool"},{"internalType":"uint64","name":"createdAt","type":"uint64"},{"internalType":"uint64","name":"updatedAt","type":"uint64"}],"internalType":"struct MuabanVND.Product","name":"","type":"tuple"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"internalType":"address","name":"seller","type":"address"}],"name":"getSellerProductIds","outputs":[{"internalType":"uint256[]","name":""}],"stateMutability":"view","type":"function"},
  {"inputs":[],"name":"owner","outputs":[{"internalType":"address","name":""}],"stateMutability":"view","type":"function"},
  {"inputs":[],"name":"payRegistration","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"uint256","name":"productId","type":"uint256"},{"internalType":"uint256","name":"quantity","type":"uint256"},{"internalType":"uint256","name":"vinPerVND","type":"uint256"},{"internalType":"string","name":"buyerInfoCipher","type":"string"}],"name":"placeOrder","outputs":[{"internalType":"uint256","name":"oid","type":"uint256"}],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"uint256","name":"orderId","type":"uint256"}],"name":"refundIfExpired","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"address","name":"","type":"address"}],"name":"registered","outputs":[{"internalType":"bool","name":""}],"stateMutability":"view","type":"function"},
  {"inputs":[{"internalType":"uint256","name":"pid","type":"uint256"},{"internalType":"bool","name":"active","type":"bool"}],"name":"setProductActive","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"uint256","name":"pid","type":"uint256"},{"internalType":"uint256","name":"priceVND","type":"uint256"},{"internalType":"uint32","name":"deliveryDaysMax","type":"uint32"},{"internalType":"address","name":"payoutWallet","type":"address"},{"internalType":"bool","name":"active","type":"bool"}],"name":"updateProduct","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[],"name":"vin","outputs":[{"internalType":"address","name":""}],"stateMutability":"view","type":"function"},
  {"inputs":[],"name":"vinDecimals","outputs":[{"internalType":"uint8","name":""}],"stateMutability":"view","type":"function"}
];

// ====== Biến trạng thái ======
let provider, signer, account, muaban, vin;
let vinDecimals = 18;

let lastRates = {
  vic_usdt: null,
  usdt_vnd: null,
  vin_vnd:  null, // = vic_usdt * 100 * usdt_vnd
  vinPerVND_wei: null // 1 VND quy ra VIN wei
};

// ====== Helpers UI ======
const $ = (id) => document.getElementById(id);
const $vinPrice = $("vinPrice");
const $btnConnect = $("btnConnect");
const $walletBox = $("walletBox");
const $btnDisconnect = $("btnDisconnect");
const $accountShort = $("accountShort");
const $menuBox = $("menuBox");
const $btnRegister = $("btnRegister");
const $btnCreate = $("btnCreate");
const $btnOrdersBuy = $("btnOrdersBuy");
const $btnOrdersSell = $("btnOrdersSell");
const $productList = $("productList");

const $formCreate = $("formCreate");
const $btnSubmitCreate = $("btnSubmitCreate");
const $createName = $("createName");
const $createIPFS = $("createIPFS"); // map -> imageCID (ưu tiên ảnh/video)
const $createUnit = $("createUnit"); // chỉ hiển thị UI (contract không có trường unit)
const $createPrice = $("createPrice");
const $createWallet = $("createWallet");
const $createDays = $("createDays");

const $formUpdate = $("formUpdate");
const $btnSubmitUpdate = $("btnSubmitUpdate");
const $updatePid = $("updatePid");
const $updatePrice = $("updatePrice");
const $updateDays = $("updateDays");
const $updateWallet = $("updateWallet");
const $updateActive = $("updateActive");

const $formBuy = $("formBuy");
const $btnSubmitBuy = $("btnSubmitBuy");
const $buyProductInfo = $("buyProductInfo");
const $buyName = $("buyName");
const $buyAddress = $("buyAddress");
const $buyPhone = $("buyPhone");
const $buyNote = $("buyNote");
const $buyQty = $("buyQty");
const $buyTotalVIN = $("buyTotalVIN");

const $ordersBuySection  = $("ordersBuySection");
const $ordersBuyList     = $("ordersBuyList");
const $ordersSellSection = $("ordersSellSection");
const $ordersSellList    = $("ordersSellList");

// Toast đơn giản
function toast(msg, type="info"){
  console[type==="error"?"error":"log"]("[toast]", msg);
  try{
    $vinPrice.textContent = msg; // dùng chip giá làm vùng thông báo nhỏ
    setTimeout(()=>{ if(lastRates.vin_vnd) $vinPrice.textContent = fmtVinVND(lastRates.vin_vnd); }, 3000);
  }catch{}
}

function short(addr){ return addr ? `${addr.slice(0,6)}…${addr.slice(-4)}` : ""; }
function fmtVND(n){ try{ return Number(n).toLocaleString("vi-VN"); }catch{ return String(n); } }
function fmtVIN(wei){
  const e = ethers.utils.formatUnits(wei, vinDecimals);
  return Number(e).toLocaleString("en-US", { maximumFractionDigits: 6 });
}
function fmtVinVND(v){ return `1 VIN = ${Number(v).toLocaleString("vi-VN", { maximumFractionDigits: 3 })} VND`; }

// ====== Giá & quy đổi ======
async function fetchRates(){
  try{
    const [r1, r2] = await Promise.all([
      fetch(BINANCE_VICUSDT, {cache:"no-store"}).then(r=>r.json()),
      fetch(COINGECKO_USDT_VND, {cache:"no-store"}).then(r=>r.json()),
    ]);
    const vic = Number(r1?.price || 0);
    const usdtvnd = Number(r2?.tether?.vnd || 0);
    if(vic>0 && usdtvnd>0){
      lastRates.vic_usdt = vic;
      lastRates.usdt_vnd = usdtvnd;
      lastRates.vin_vnd  = vic * 100 * usdtvnd;
      // 1 VND ~ X VIN wei
      // VIN/VND = A  => 1 VIN = A VND => 1 VND = 1/A VIN
      // vinPerVND (wei) = 1e18 / A
      lastRates.vinPerVND_wei = ethers.utils.parseUnits("1", vinDecimals).div(ethers.BigNumber.from(Math.max(1, Math.floor(lastRates.vin_vnd))));
      if($vinPrice) $vinPrice.textContent = fmtVinVND(lastRates.vin_vnd);
    }else{
      $vinPrice.textContent = "Loading price...";
    }
  }catch(e){
    console.warn("[rates]", e);
    $vinPrice.textContent = "Loading price...";
  }
}

// ====== Kết nối ví & network ======
async function ensureViction(){
  const eth = window.ethereum;
  if(!eth) return false;
  const chainId = await eth.request({ method: "eth_chainId" });
  if(chainId === VIC.CHAIN_ID_HEX) return true;
  try{
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: VIC.CHAIN_ID_HEX }] });
    return true;
  }catch(err){
    if(err && err.code === 4902){
      await eth.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: VIC.CHAIN_ID_HEX,
          chainName: VIC.NAME,
          nativeCurrency: { name:"VIC", symbol:"VIC", decimals:18 },
          rpcUrls: [VIC.RPC],
          blockExplorerUrls: [VIC.EXPL]
        }]
      });
      return true;
    }
    return false;
  }
}

async function connect(){
  if(!window.ethereum) return toast("Không tìm thấy ví. Hãy cài MetaMask.", "error");
  try{
    provider = new ethers.providers.Web3Provider(window.ethereum, "any");
    await provider.send("eth_requestAccounts", []);
    signer = provider.getSigner();
    const ok = await ensureViction();
    if(!ok){ toast("Sai mạng. Vui lòng chuyển sang Viction.", "warn"); return; }
    account = await signer.getAddress();

    // Khởi tạo contracts
    muaban = new ethers.Contract(MUABAN_ADDR, MUABAN_ABI, signer);
    vin    = new ethers.Contract(VIN_ADDR, ERC20_ABI, signer);
    vinDecimals = await vin.decimals().catch(()=>18);

    await refreshWalletUI();
    await checkRegistrationAndMenu();
    await loadProducts(); // quét & hiển thị sản phẩm

    // Sự kiện ví
    window.ethereum?.on?.("accountsChanged", ()=> location.reload());
    window.ethereum?.on?.("chainChanged", ()=> location.reload());
  }catch(e){
    console.error("[connect]", e);
    toast("Kết nối ví thất bại.", "error");
  }
}

function disconnect(){
  // Với MetaMask không có API disconnect, ta chỉ ẩn UI
  account = null; signer = null; provider = null; muaban = null; vin = null;
  $walletBox.classList.add("hidden");
  $menuBox.classList.add("hidden");
  $btnConnect.classList.remove("hidden");
  $btnConnect.textContent = "Kết nối ví";
  $accountShort.removeAttribute("href");
}

// ====== Wallet UI ======
async function refreshWalletUI(){
  if(!signer) return;
  const [vinBal, vicBal] = await Promise.all([
    vin.balanceOf(account).catch(()=>ethers.constants.Zero),
    signer.getBalance().catch(()=>ethers.constants.Zero),
  ]);
  if($btnConnect){
    $btnConnect.classList.add("connected");
    $btnConnect.textContent = short(account);
    $btnConnect.classList.add("hidden");
  }
  if($walletBox){
    $walletBox.classList.remove("hidden");
    $("vinBalance").textContent = `VIN: ${fmtVIN(vinBal)}`;
    $("vicBalance").textContent = `VIC: ${ethers.utils.formatEther(vicBal)}`;
    $accountShort.textContent = short(account);
    $accountShort.href = `${VIC.EXPL}/address/${account}`;
  }
}

// ====== Đăng ký & allowance ======
async function contractRegFee(){
  try{ return await muaban.REG_FEE(); }catch{ return ethers.utils.parseUnits("0.001", 18); }
}
async function allowanceOf(user, spender){
  try{ return await vin.allowance(user, spender); }catch{ return ethers.constants.Zero; }
}
async function ensureAllowance(minWei){
  const current = await allowanceOf(account, MUABAN_ADDR);
  if(current.gte(minWei)) return;
  // Approve dư 10 lần để tránh phải approve lại nhiều lần
  const need = minWei.mul(ethers.BigNumber.from(10));
  const tx = await vin.approve(MUABAN_ADDR, need);
  await tx.wait();
}
async function registerIfNeeded(){
  const isReg = await muaban.registered(account);
  if(isReg) return true;
  const fee = await contractRegFee();
  await ensureAllowance(fee);
  const tx = await muaban.payRegistration();
  await tx.wait();
  toast("Đăng ký ví thành công!");
  return true;
}

async function checkRegistrationAndMenu(){
  if(!account) return;
  const isReg = await muaban.registered(account);
  $menuBox.classList.remove("hidden");
  $btnRegister.classList.toggle("hidden", !!isReg);
  $btnCreate.classList.toggle("hidden", !isReg);
  $btnOrdersBuy.classList.toggle("hidden", !isReg);
  $btnOrdersSell.classList.toggle("hidden", !isReg);
}

// ====== Sản phẩm: quét và hiển thị ======
// Vì contract không có danh sách tất cả sản phẩm, ta quét từ pid=1..MAX rồi lọc
const MAX_PID_SCAN = 200;

async function loadProducts(){
  $productList.innerHTML = `<div class="order-row">Đang tải sản phẩm…</div>`;
  const items = [];
  for(let pid=1; pid<=MAX_PID_SCAN; pid++){
    try{
      const p = await muaban.getProduct(pid);
      // Lọc những ô trống (seller = 0x0) hoặc tên rỗng
      if(p && p.seller && p.seller !== ethers.constants.AddressZero && (p.name || "").trim().length){
        items.push(p);
      }
    }catch{
      // Có thể vượt số pid hiện hữu => bỏ qua
    }
  }
  if(items.length === 0){
    $productList.innerHTML = `<div class="order-row">Chưa có sản phẩm nào.</div>`;
    return;
  }
  // Render
  $productList.innerHTML = items.map(renderProductCard).join("");
  // Gắn sự kiện cho nút trên thẻ
  items.forEach(p=>{
    const buyBtn = document.querySelector(`[data-act="buy-${p.productId}"]`);
    if(buyBtn) buyBtn.addEventListener("click", ()=> openBuyModal(p));
    const updBtn = document.querySelector(`[data-act="upd-${p.productId}"]`);
    if(updBtn) updBtn.addEventListener("click", ()=> openUpdateModal(p));
  });
}

function renderProductCard(p){
  // Ẩn thông tin người bán trên UI công khai theo yêu cầu
  const img = (p.imageCID || "").startsWith("ipfs://")
    ? p.imageCID.replace("ipfs://","https://ipfs.io/ipfs/")
    : (p.imageCID || "https://ipfs.io/ipfs/");
  const name = escapeHtml(p.name || "Sản phẩm");
  const price = fmtVND(p.priceVND || 0);
  const stockBadge = p.active ? `<span class="stock-badge">Còn hàng</span>` : `<span class="stock-badge out">Hết hàng</span>`;

  // Logic nút theo quyền
  let actions = ``;
  const isMeSeller = (account && (p.seller?.toLowerCase() === account?.toLowerCase()));
  const canBuy = !!account && !isMeSeller && p.active;

  if(isMeSeller){
    actions += `<button class="btn" data-act="upd-${p.productId}">Cập nhật sản phẩm</button>`;
  }
  if(canBuy){
    actions += `<button class="btn primary" data-act="buy-${p.productId}">Mua</button>`;
  }

  return `
<div class="product-card">
  <img class="product-thumb" src="${img}" alt="">
  <div class="product-info">
    <div class="product-top">
      <h3 class="product-title">${name}</h3>
      ${stockBadge}
    </div>
    <div class="product-meta">
      <span class="price-vnd">Giá: ${price} VND</span>
    </div>
    <div class="card-actions">
      ${actions || `<span class="badge">Đăng nhập để mua</span>`}
    </div>
  </div>
</div>
`;
}

// ====== Modal helpers ======
function openModal(el){
  el.classList.remove("hidden");
  document.body.classList.add("no-scroll");
}
function closeModal(el){
  el.classList.add("hidden");
  document.body.classList.remove("no-scroll");
}
document.querySelectorAll(".modal .close")?.forEach(btn=>{
  btn.addEventListener("click", (e)=>{
    const modal = e.target.closest(".modal");
    if(modal) closeModal(modal);
  });
});

// ====== Đăng sản phẩm ======
function openCreateModal(){
  $createName.value = "";
  $createIPFS.value = "";
  $createUnit.value = "";
  $createPrice.value = "";
  $createWallet.value = account || "";
  $createDays.value = "3";
  openModal($formCreate);
}

async function submitCreate(){
  try{
    if(!signer) await connect();
    await registerIfNeeded();

    const name = ($createName.value||"").trim();
    const ipfs = ($createIPFS.value||"").trim();
    const priceVND = ethers.BigNumber.from(($createPrice.value||"0").toString());
    const deliveryDays = parseInt($createDays.value||"0",10);
    const payout = ($createWallet.value||"").trim();

    if(!name) return toast("Tên sản phẩm bắt buộc.","warn");
    if(!priceVND.gt(0)) return toast("Giá VND phải > 0.","warn");
    if(!deliveryDays) return toast("Thời gian giao hàng (ngày) > 0.","warn");
    if(!ethers.utils.isAddress(payout)) return toast("Ví nhận thanh toán không hợp lệ.","warn");

    // Contract có các trường: name, descriptionCID, imageCID
    const descriptionCID = "";      // nếu có thể bạn dán CID mô tả sau
    const imageCID = ipfs || "";    // ưu tiên ảnh/video

    const tx = await muaban.createProduct(
      name, descriptionCID, imageCID,
      priceVND, deliveryDays, payout, true
    );
    await tx.wait();
    closeModal($formCreate);
    toast("Đăng sản phẩm thành công!");
    await loadProducts();
  }catch(e){
    console.error("[createProduct]", e);
    handleRpcError(e, "Không thể đăng sản phẩm");
  }
}

// ====== Cập nhật sản phẩm ======
function openUpdateModal(p){
  $updatePid.value = String(p.productId);
  $updatePrice.value = String(p.priceVND || 0);
  $updateDays.value  = String(p.deliveryDaysMax || 1);
  $updateWallet.value = p.payoutWallet || account || "";
  $updateActive.checked = !!p.active;
  openModal($formUpdate);
}

async function submitUpdate(){
  try{
    if(!signer) await connect();
    await registerIfNeeded();

    const pid = parseInt($updatePid.value||"0",10);
    const priceVND = ethers.BigNumber.from(($updatePrice.value||"0").toString());
    const deliveryDays = parseInt($updateDays.value||"0",10);
    const payout = ($updateWallet.value||"").trim();
    const active = !!$updateActive.checked;

    if(!pid) return toast("Thiếu productId.","warn");
    if(!priceVND.gt(0)) return toast("Giá VND phải > 0.","warn");
    if(!deliveryDays) return toast("Thời gian giao hàng > 0.","warn");
    if(!ethers.utils.isAddress(payout)) return toast("Ví nhận thanh toán không hợp lệ.","warn");

    const tx = await muaban.updateProduct(pid, priceVND, deliveryDays, payout, active);
    await tx.wait();
    closeModal($formUpdate);
    toast("Cập nhật thành công!");
    await loadProducts();
  }catch(e){
    console.error("[updateProduct]", e);
    handleRpcError(e, "Không thể cập nhật sản phẩm");
  }
}

// ====== Mua hàng ======
let currentBuy = { product: null };

function openBuyModal(p){
  currentBuy.product = p;
  $buyName.value = ""; $buyAddress.value = ""; $buyPhone.value = ""; $buyNote.value = "";
  $buyQty.value = "1";
  $buyProductInfo.innerHTML = `
    <div class="order-row"><span class="order-strong">${escapeHtml(p.name)}</span></div>
    <div class="order-row">Giá: <span class="order-strong">${fmtVND(p.priceVND)} VND</span></div>
    <div class="order-row">Tối đa giao: ${p.deliveryDaysMax} ngày</div>
  `;
  updateBuyTotal();
  openModal($formBuy);
}
function updateBuyTotal(){
  const qty = Math.max(1, parseInt($buyQty.value||"1",10));
  const p = currentBuy.product;
  if(!p || !lastRates.vinPerVND_wei) { $buyTotalVIN.textContent = "Tổng VIN cần trả: …"; return; }
  // vinAmount = ceil( priceVND * qty * vinPerVND )
  const totalVND = ethers.BigNumber.from(p.priceVND).mul(qty);
  const vin = totalVND.mul(lastRates.vinPerVND_wei); // ceil được xử lý trong contract, ở đây chỉ hiển thị ước tính
  $buyTotalVIN.textContent = `Tổng VIN cần trả: ~ ${fmtVIN(vin)} VIN`;
}
$buyQty?.addEventListener("input", updateBuyTotal);

function encodeBuyerInfo(obj){
  try{ return btoa(unescape(encodeURIComponent(JSON.stringify(obj)))); }
  catch{ return ""; }
}

async function submitBuy(){
  try{
    if(!signer) await connect();
    await registerIfNeeded();

    const p = currentBuy.product;
    if(!p) return;
    const qty = Math.max(1, parseInt($buyQty.value||"1",10));
    if(!lastRates.vinPerVND_wei){
      await fetchRates();
      if(!lastRates.vinPerVND_wei) return toast("Chưa có giá quy đổi, thử lại sau.", "warn");
    }

    // Tính tổng VIN cần escrow để đảm bảo allowance đủ (lấy ceil ở FE thêm biên an toàn)
    const totalVND = ethers.BigNumber.from(p.priceVND).mul(qty);
    const estVin = totalVND.mul(lastRates.vinPerVND_wei);

    // Đảm bảo allowance đủ cho placeOrder (nhiều lỗi -32603 trước đây là do thiếu approve)
    await ensureAllowance(estVin);

    const buyerInfoCipher = encodeBuyerInfo({
      name: ($buyName.value||"").trim(),
      address: ($buyAddress.value||"").trim(),
      phone: ($buyPhone.value||"").trim(),
      note:  ($buyNote.value||"").trim()
    });

    const tx = await muaban.placeOrder(
      p.productId,
      ethers.BigNumber.from(qty),
      lastRates.vinPerVND_wei,   // VIN wei per 1 VND
      buyerInfoCipher
    );
    await tx.wait();
    closeModal($formBuy);
    toast("Đặt mua thành công! VIN đã được ký quỹ.");
  }catch(e){
    console.error("[placeOrder]", e);
    handleRpcError(e, "Không thể đặt mua");
  }
}

// ====== Đơn hàng của tôi (placeholder) ======
// Contract không có API liệt kê tất cả đơn theo buyer/seller → hiển thị trạng thái rỗng
function showOrdersBuy(){
  $ordersSellSection.classList.add("hidden");
  $ordersBuySection.classList.remove("hidden");
  $ordersBuyList.innerHTML = `<div class="order-card">Chưa có đơn hàng mua nào để hiển thị.</div>`;
}
function showOrdersSell(){
  $ordersBuySection.classList.add("hidden");
  $ordersSellSection.classList.remove("hidden");
  $ordersSellList.innerHTML = `<div class="order-card">Chưa có đơn hàng bán nào để hiển thị.</div>`;
}

// ====== Xử lý lỗi RPC thân thiện ======
function handleRpcError(err, prefix="Lỗi"){
  let msg = `${prefix}: Internal JSON-RPC error.`;
  const raw = String(err?.message||"");
  const code = err?.code;

  // Các trường hợp hay gặp: thiếu allowance / chưa đăng ký / sai mạng
  if(raw.includes("NOT_REGISTERED")){
    msg = `${prefix}: Ví chưa đăng ký. Hãy bấm "Đăng ký" (0.001 VIN).`;
  }else if(raw.includes("VIN_TRANSFER_FAIL") || raw.includes("TRANSFER_FROM_FAILED")){
    msg = `${prefix}: Thiếu allowance/không đủ VIN. Vui lòng kiểm tra số dư VIN và thử lại.`;
  }else if(raw.includes("insufficient funds") || raw.includes("gas")){
    msg = `${prefix}: Không đủ VIC trả phí gas.`;
  }else if(code === 4001){
    msg = `${prefix}: Bạn đã từ chối giao dịch.`;
  }

  toast(msg, "error");
}

// ====== HTML helpers ======
function escapeHtml(s){
  return (s||"").replace(/[&<>"'`=\/]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':"&quot;','\'':'&#39;','/':'&#x2F;','`':'&#x60;','=':'&#x3D;'}[c]));
}

// ====== Gắn sự kiện UI ======
$btnConnect?.addEventListener("click", connect);
$btnDisconnect?.addEventListener("click", disconnect);

$btnRegister?.addEventListener("click", async ()=>{
  try{
    if(!signer) await connect();
    const fee = await contractRegFee();
    await ensureAllowance(fee);
    const tx = await muaban.payRegistration();
    await tx.wait();
    toast("Đăng ký thành công!");
    await checkRegistrationAndMenu();
  }catch(e){
    console.error("[register]", e);
    handleRpcError(e, "Không thể đăng ký");
  }
});

$btnCreate?.addEventListener("click", openCreateModal);
$btnSubmitCreate?.addEventListener("click", submitCreate);

$btnSubmitUpdate?.addEventListener("click", submitUpdate);

$btnOrdersBuy?.addEventListener("click", showOrdersBuy);
$btnOrdersSell?.addEventListener("click", showOrdersSell);

$btnSubmitBuy?.addEventListener("click", submitBuy);

// Click nền tối để đóng modal
[$formCreate, $formUpdate, $formBuy].forEach(mod=>{
  mod?.addEventListener("click", (e)=>{ if(e.target === mod) closeModal(mod); });
});

// ====== Khởi động ======
(async function boot(){
  // Giá VIN/VND tick mỗi 20s
  await fetchRates();
  setInterval(fetchRates, 20000);

  // Nếu đã có provider thì không auto-connect; đợi người dùng bấm
  // Nhưng vẫn có thể hiển thị danh sách sản phẩm công khai
  try{
    provider = new ethers.providers.JsonRpcProvider(VIC.RPC);
    muaban  = new ethers.Contract(MUABAN_ADDR, MUABAN_ABI, provider);
    await loadProducts();
  }catch(e){
    console.warn("[public provider init]", e);
  }
})();
</script>
