/* ============================================================================
   muaban.vin — app.js (ethers v5, Viction chain 88)
   ============================================================================ */

/* -------------------- 0) Consts & ABIs -------------------- */
// Addresses (VIC)
const MUABAN_ADDR = "0x190FD18820498872354eED9C4C080cB365Cd12E0"; // Contract
const VIN_ADDR     = "0x941F63807401efCE8afe3C9d88d368bAA287Fac4"; // VIN token

// Chain info (Viction)
const VIC_CHAIN_ID_DEC = 88;
const VIC_CHAIN_ID_HEX = "0x58";
const VIC_RPC          = "https://rpc.viction.xyz";
const VIC_EXPLORER     = "https://www.vicscan.xyz";

// Minimal toast (you can replace with a nicer UI)
function toast(msg, type="info"){ console.log(`[${type}] ${msg}`); alert(msg); }

// Number helpers
const fmtVND  = (n)=> new Intl.NumberFormat("vi-VN").format(Math.floor(n));
const short   = (addr)=> addr ? `${addr.slice(0,6)}…${addr.slice(-4)}` : "";
const toHex   = (str)=> window.btoa(unescape(encodeURIComponent(str))); // lightweight encoding

// DOM
const $ = (sel)=> document.querySelector(sel);
const $$ = (sel)=> Array.from(document.querySelectorAll(sel));

const $vinPrice       = $("#vinPrice");
const $btnConnect     = $("#btnConnect");
const $btnDisconnect  = $("#btnDisconnect");
const $walletBox      = $("#walletBox");
const $vinBalance     = $("#vinBalance");
const $vicBalance     = $("#vicBalance");
const $accountShort   = $("#accountShort");

const $menuBox        = $("#menuBox");
const $btnRegister    = $("#btnRegister");
const $btnCreate      = $("#btnCreate");
const $btnOrdersBuy   = $("#btnOrdersBuy");
const $btnOrdersSell  = $("#btnOrdersSell");

const $searchInput    = $("#searchInput");
const $btnSearch      = $("#btnSearch");
const $productList    = $("#productList");

// Create modal
const $modalCreate    = $("#formCreate");
const $createName     = $("#createName");
const $createIPFS     = $("#createIPFS");
const $createUnit     = $("#createUnit");
const $createPrice    = $("#createPrice");
const $createWallet   = $("#createWallet");
const $createDays     = $("#createDays");
const $btnSubmitCreate= $("#btnSubmitCreate");

// Update modal
const $modalUpdate    = $("#formUpdate");
const $updatePid      = $("#updatePid");
const $updatePrice    = $("#updatePrice");
const $updateDays     = $("#updateDays");
const $updateWallet   = $("#updateWallet");
const $updateActive   = $("#updateActive");
const $btnSubmitUpdate= $("#btnSubmitUpdate");

// Buy modal
const $modalBuy       = $("#formBuy");
const $buyProductInfo = $("#buyProductInfo");
const $buyName        = $("#buyName");
const $buyAddress     = $("#buyAddress");
const $buyPhone       = $("#buyPhone");
const $buyNote        = $("#buyNote");
const $buyQty         = $("#buyQty");
const $buyTotalVIN    = $("#buyTotalVIN");
const $btnSubmitBuy   = $("#btnSubmitBuy");

// Orders sections
const $ordersBuySection  = $("#ordersBuySection");
const $ordersBuyList     = $("#ordersBuyList");
const $ordersSellSection = $("#ordersSellSection");
const $ordersSellList    = $("#ordersSellList");

// State
let provider, signer, account;
let vin, muaban; // ethers.Contract
let isRegistered = false;
let priceCache = { vinVND: null, vinPerVND_wei: null };
let productCache = []; // scanned products
let currentBuy = null; // {pid, qty, priceVND, unit, title, seller}

/* -------------------- ABIs -------------------- */
// Muaban ABI (from Muaban_ABI.json)
const MUABAN_ABI = /* paste from file */ [
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
  {"inputs":[{"internalType":"uint256","name":"oid","type":"uint256"}],"name":"getOrder","outputs":[{"components":[{"internalType":"uint256","name":"orderId","type":"uint256"},{"internalType":"uint256","name":"productId","type":"uint256"},{"internalType":"address","name":"buyer","type":"address"},{"internalType":"address","name":"seller","type":"address"},{"internalType":"uint256","name":"quantity","type":"uint256"},{"internalType":"uint256","name":"vinAmount","type":"uint256"},{"internalType":"uint256","name":"placedAt","type":"uint256"},{"internalType":"uint256","name":"deadline","type":"uint256"},{"internalType":"enum MuabanVND.OrderStatus","name":"status","type":"uint8"},{"internalType":"string","name":"buyerInfoCipher","type":"string"}],"internalType":"struct MuabanVND.Order","name":"","type":"tuple"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"internalType":"uint256","name":"pid","type":"uint256"}],"name":"getProduct","outputs":[{"components":[{"internalType":"uint256","name":"productId","type":"uint256"},{"internalType":"address","name":"seller","type":"address"},{"internalType":"string","name":"name","type":"string"},{"internalType":"string","name":"descriptionCID","type":"string"},{"internalType":"string","name":"imageCID","type":"string"},{"internalType":"uint256","name":"priceVND","type":"uint256"},{"internalType":"uint32","name":"deliveryDaysMax","type":"uint32"},{"internalType":"address","name":"payoutWallet","type":"address"},{"internalType":"bool","name":"active","type":"bool"},{"internalType":"uint64","name":"createdAt","type":"uint64"},{"internalType":"uint64","name":"updatedAt","type":"uint64"}],"internalType":"struct MuabanVND.Product","name":"","type":"tuple"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"internalType":"address","name":"seller","type":"address"}],"name":"getSellerProductIds","outputs":[{"internalType":"uint256[]","name":""}],"stateMutability":"view","type":"function"},
  {"inputs":[],"name":"owner","outputs":[{"internalType":"address","name":""}],"stateMutability":"view","type":"function"},
  {"inputs":[],"name":"payRegistration","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"uint256","name":"productId","type":"uint256"},{"internalType":"uint256","name":"quantity","type":"uint256"},{"internalType":"uint256","name":"vinPerVND","type":"uint256"},{"internalType":"string","name":"buyerInfoCipher","type":"string"}],"name":"placeOrder","outputs":[{"internalType":"uint256","name":"oid","type":"uint256"}],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"uint256","name":"pid","type":"uint256"}],"name":"refundIfExpired","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"address","name":"","type":"address"}],"name":"registered","outputs":[{"internalType":"bool","name":""}],"stateMutability":"view","type":"function"},
  {"inputs":[{"internalType":"address","name":"","type":"address"},{"internalType":"uint256","name":"","type":"uint256"}],"name":"sellerProducts","outputs":[{"internalType":"uint256","name":""}],"stateMutability":"view","type":"function"},
  {"inputs":[{"internalType":"uint256","name":"pid","type":"uint256"},{"internalType":"bool","name":"active","type":"bool"}],"name":"setProductActive","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"uint256","name":"pid","type":"uint256"},{"internalType":"uint256","name":"priceVND","type":"uint256"},{"internalType":"uint32","name":"deliveryDaysMax","type":"uint32"},{"internalType":"address","name":"payoutWallet","type":"address"},{"internalType":"bool","name":"active","type":"bool"}],"name":"updateProduct","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[],"name":"vin","outputs":[{"internalType":"contract IERC20","name":"","type":"address"}],"stateMutability":"view","type":"function"},
  {"inputs":[],"name":"vinDecimals","outputs":[{"internalType":"uint8","name":"","type":"uint8"}],"stateMutability":"view","type":"function"}
];

// VIN (ERC20) ABI (from VinToken_ABI.json)
const VIN_ABI = [
  {"inputs":[{"internalType":"address","name":"owner","type":"address"}],"name":"balanceOf","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"internalType":"address","name":"spender","type":"address"},{"internalType":"uint256","name":"amount","type":"uint256"}],"name":"approve","outputs":[{"internalType":"bool","name":""}],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"address","name":"owner","type":"address"},{"internalType":"address","name":"spender","type":"address"}],"name":"allowance","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"internalType":"address","name":"recipient","type":"address"},{"internalType":"uint256","name":"amount","type":"uint256"}],"name":"transfer","outputs":[{"internalType":"bool","name":""}],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"address","name":"sender","type":"address"},{"internalType":"address","name":"recipient","type":"address"},{"internalType":"uint256","name":"amount","type":"uint256"}],"name":"transferFrom","outputs":[{"internalType":"bool","name":""}],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[],"name":"decimals","outputs":[{"internalType":"uint8","name":""}],"stateMutability":"view","type":"function"},
  {"inputs":[],"name":"name","outputs":[{"internalType":"string","name":""}],"stateMutability":"view","type":"function"},
  {"inputs":[],"name":"symbol","outputs":[{"internalType":"string","name":""}],"stateMutability":"view","type":"function"}
];

/* -------------------- 1) Price: 1 VIN (VND) -------------------- */
// VIN/VND = (VICUSDT price × 100) × USDT→VND
async function fetchVinVND(){
  try{
    const [vicRes, usdVndRes] = await Promise.all([
      fetch("https://api.binance.com/api/v3/ticker/price?symbol=VICUSDT", {cache:"no-store"}),
      fetch("https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=vnd", {cache:"no-store"})
    ]);
    const vicJson = await vicRes.json();
    const usdVndJson = await usdVndRes.json();
    const vicUsdt = Number(vicJson?.price || 0);
    const usdtVnd = Number(usdVndJson?.tether?.vnd || 0);
    if(!vicUsdt || !usdtVnd) throw new Error("Không lấy được tỷ giá");

    const vinVnd = vicUsdt * 100 * usdtVnd;           // VND cho 1 VIN
    const vinPerVND_wei = Math.floor(1e18 / vinVnd);  // VIN wei cho 1 VND (làm tròn xuống)

    priceCache = { vinVND: vinVnd, vinPerVND_wei };
    if($vinPrice) $vinPrice.textContent = `1 VIN = ${fmtVND(vinVnd)} VND`;
  }catch(e){
    console.warn(e);
    if($vinPrice) $vinPrice.textContent = "Loading price...";
  }
}

/* -------------------- 2) Wallet / Network -------------------- */
async function ensureViction(){
  const eth = window.ethereum;
  if(!eth) return false;
  const chainId = await eth.request({ method: "eth_chainId" });
  if(chainId === VIC_CHAIN_ID_HEX) return true;
  try{
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: VIC_CHAIN_ID_HEX }] });
    return true;
  }catch(err){
    if(err?.code === 4902){
      await eth.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: VIC_CHAIN_ID_HEX,
          chainName: "Viction Mainnet",
          nativeCurrency: { name:"VIC", symbol:"VIC", decimals:18 },
          rpcUrls: [VIC_RPC],
          blockExplorerUrls: [VIC_EXPLORER]
        }]
      });
      return true;
    }
    throw err;
  }
}

async function connect(){
  if(!window.ethereum){ toast("Không tìm thấy ví. Hãy cài MetaMask.", "warn"); return; }
  provider = new ethers.providers.Web3Provider(window.ethereum, "any");
  await provider.send("eth_requestAccounts", []);
  signer   = provider.getSigner();
  const ok = await ensureViction();
  if(!ok){ toast("Hãy chuyển sang mạng Viction.", "warn"); return; }

  account = await signer.getAddress();
  vin     = new ethers.Contract(VIN_ADDR, VIN_ABI, signer);
  muaban  = new ethers.Contract(MUABAN_ADDR, MUABAN_ABI, signer);

  // UI
  $btnConnect?.classList.add("hidden");
  $walletBox?.classList.remove("hidden");
  $menuBox?.classList.remove("hidden");
  $accountShort.href = `${VIC_EXPLORER}/address/${account}`;
  $accountShort.textContent = short(account);

  // Events
  window.ethereum?.on?.("accountsChanged", ()=> location.reload());
  window.ethereum?.on?.("chainChanged",   ()=> location.reload());

  await refreshBalancesAndState();
  await loadProducts(); // scan public list
}

function disconnect(){
  account = null; signer = null; provider = null;
  $btnConnect?.classList.remove("hidden");
  $walletBox?.classList.add("hidden");
  $menuBox?.classList.add("hidden");
  $ordersBuySection.classList.add("hidden");
  $ordersSellSection.classList.add("hidden");
  $productList.innerHTML = "";
}

/* -------------------- 3) Balances & Registered -------------------- */
async function refreshBalancesAndState(){
  if(!signer || !account) return;
  const [vinBal, vicBal, reg] = await Promise.all([
    vin.balanceOf(account),
    provider.getBalance(account),
    muaban.registered(account)
  ]);
  $vinBalance.textContent = `VIN: ${ethers.utils.formatUnits(vinBal,18)}`;
  $vicBalance.textContent = `VIC: ${ethers.utils.formatEther(vicBal)}`;

  isRegistered = reg;
  $btnRegister.classList.toggle("hidden", !!reg);
  $btnCreate.classList.toggle("hidden", !reg);
  $btnOrdersBuy.classList.toggle("hidden", !reg);
  $btnOrdersSell.classList.toggle("hidden", !reg);
}

/* -------------------- 4) Approvals -------------------- */
async function ensureAllowance(spender, neededWei){
  const current = await vin.allowance(account, spender);
  if(current.gte(neededWei)) return;
  const tx = await vin.approve(spender, neededWei);
  await tx.wait();
}

/* -------------------- 5) Register -------------------- */
async function onRegister(){
  try{
    const regFee = await muaban.REG_FEE();
    await ensureAllowance(MUABAN_ADDR, regFee);
    const tx = await muaban.payRegistration();
    toast("Đang gửi giao dịch đăng ký…"); await tx.wait();
    toast("Đăng ký thành công!");
    await refreshBalancesAndState();
  }catch(e){
    console.error(e);
    toast("Đăng ký thất bại. Vui lòng kiểm tra ví & phí gas.", "error");
  }
}

/* -------------------- 6) Create / Update Product -------------------- */
function openModal(el){ document.body.classList.add("no-scroll"); el.classList.remove("hidden"); }
function closeModal(){ document.body.classList.remove("no-scroll"); $$(".modal").forEach(m=>m.classList.add("hidden")); }

function resetCreateForm(){
  $createName.value = "";
  $createIPFS.value = "";
  $createUnit.value = "";
  $createPrice.value = "";
  $createWallet.value = account || "";
  $createDays.value = "3";
}

async function onSubmitCreate(){
  try{
    if(!isRegistered) return toast("Vui lòng đăng ký ví trước.", "warn");
    const name = ($createName.value||"").trim();
    const ipfs = ($createIPFS.value||"").trim();
    const unit = ($createUnit.value||"").trim();
    const priceVND = BigInt($createPrice.value);
    const wallet   = ($createWallet.value||"").trim();
    const days     = Number($createDays.value||"0");
    if(!name || !ipfs || !unit || !priceVND || !days || !wallet) return toast("Điền đủ 6 trường trước khi đăng.", "warn");

    const tx = await muaban.createProduct(
      `${name} (${unit})`,    // gộp unit vào name để tiện hiển thị
      ipfs,                   // descriptionCID (link IPFS)
      ipfs,                   // imageCID (tạm dùng cùng link)
      priceVND.toString(),
      days,
      wallet,
      true
    );
    toast("Đang gửi giao dịch đăng sản phẩm…");
    const rcpt = await tx.wait();
    toast("Đăng sản phẩm thành công!");
    closeModal();
    await loadProducts(true); // refresh nhanh
  }catch(e){
    console.error(e);
    toast("Không thể đăng sản phẩm. Kiểm tra: đã kết nối ví, đúng mạng Viction, đủ VIC gas, đã Đăng ký.", "error");
  }
}

async function onSubmitUpdate(){
  try{
    const pid = Number($updatePid.value);
    const priceVND = BigInt($updatePrice.value||"0");
    const days     = Number($updateDays.value||"0");
    const wallet   = ($updateWallet.value||"").trim();
    const active   = !!$updateActive.checked;
    if(!pid || !priceVND || !days || !wallet) return toast("Thiếu dữ liệu cập nhật.", "warn");

    const tx = await muaban.updateProduct(pid, priceVND.toString(), days, wallet, active);
    toast("Đang cập nhật sản phẩm…"); await tx.wait();
    toast("Cập nhật thành công!");
    closeModal();
    await loadProducts(true);
  }catch(e){
    console.error(e);
    toast("Cập nhật thất bại.", "error");
  }
}

/* -------------------- 7) Listing products (scan) -------------------- */
async function fetchProduct(pid){
  try{
    const p = await muaban.getProduct(pid);
    if(!p || !p.seller || p.seller === ethers.constants.AddressZero) return null;
    return p;
  }catch{
    return null;
  }
}

async function scanProducts(maxProbe=200, maxMiss=12){
  const results = [];
  let misses = 0;
  for(let i=1;i<=maxProbe;i++){
    const p = await fetchProduct(i);
    if(p && p.productId && p.seller !== ethers.constants.AddressZero){
      results.push(p);
      misses = 0;
    }else{
      misses++;
      if(misses>=maxMiss) break;
    }
  }
  return results;
}

function renderProducts(list){
  if(!list.length){
    $productList.innerHTML = `<div class="product-card"><div></div><div class="product-info">Chưa có sản phẩm nào.</div></div>`;
    return;
  }
  const q = ($searchInput.value||"").toLowerCase();
  const filtered = list.filter(p => (p.name||"").toLowerCase().includes(q));

  $productList.innerHTML = filtered.map(p=>{
    const img = (p.imageCID||"").startsWith("ipfs://")
      ? p.imageCID.replace("ipfs://","https://ipfs.io/ipfs/")
      : (p.imageCID||"");
    const unit = (p.name||"").match(/\((.+)\)$/)?.[1] || "-";
    const stockBadge = p.active ? `<span class="stock-badge">Còn hàng</span>` : `<span class="stock-badge out">Hết hàng</span>`;
    const sellerShort = short(String(p.seller));
    const canBuy = p.active && account && account.toLowerCase() !== String(p.seller).toLowerCase();

    return `
      <div class="product-card" data-pid="${p.productId}" data-unit="${unit}" data-price="${p.priceVND}" data-seller="${p.seller}" data-title="${p.name}">
        <img class="product-thumb" src="${img}" alt="">
        <div class="product-info">
          <div class="product-top">
            <h3 class="product-title">${p.name||"(không tên)"}</h3>
            ${stockBadge}
          </div>
          <div class="product-meta">
            <span class="price-vnd">${fmtVND(p.priceVND)} VND</span>
            <span class="unit">/ ${unit}</span>
          </div>
          <div class="card-actions">
            ${canBuy ? `<button class="btn primary act-buy">Mua</button>` : ``}
            ${account && String(p.seller).toLowerCase()===account.toLowerCase()
              ? `<button class="btn act-update">Cập nhật</button>`
              : ``}
            <a class="btn" target="_blank" rel="noopener" href="${VIC_EXPLORER}/address/${p.seller}">Người bán: ${sellerShort}</a>
          </div>
        </div>
      </div>
    `;
  }).join("");

  // bind actions
  $$(".act-buy").forEach(btn=> btn.addEventListener("click", onClickBuy));
  $$(".act-update").forEach(btn=> btn.addEventListener("click", onClickOpenUpdate));
}

async function loadProducts(force=false){
  if(productCache.length && !force){ renderProducts(productCache); return; }
  try{
    $productList.innerHTML = `<div class="product-card"><div></div><div class="product-info">Đang tải sản phẩm…</div></div>`;
    productCache = await scanProducts();
    renderProducts(productCache);
  }catch(e){
    console.error(e);
    $productList.innerHTML = `<div class="product-card"><div></div><div class="product-info">Không tải được danh sách sản phẩm.</div></div>`;
  }
}

/* -------------------- 8) Buy flow -------------------- */
function onClickBuy(e){
  const card = e.target.closest(".product-card");
  if(!card) return;
  currentBuy = {
    pid: Number(card.dataset.pid),
    priceVND: BigInt(card.dataset.price),
    unit: card.dataset.unit,
    title: card.dataset.title,
    seller: card.dataset.seller
  };
  $buyQty.value = 1;
  updateBuyTotal();
  $buyProductInfo.innerHTML = `
    <div><strong>${currentBuy.title}</strong></div>
    <div>${fmtVND(currentBuy.priceVND)} VND / ${currentBuy.unit}</div>
  `;
  openModal($modalBuy);
}

function updateBuyTotal(){
  const qty = Number($buyQty.value||"1");
  const totalVND = Number(currentBuy.priceVND) * qty;
  const vinVND = priceCache.vinVND || 0;
  const estVIN = vinVND ? (totalVND / vinVND) : 0;
  $buyTotalVIN.textContent = `Tổng VIN cần trả: ${estVIN.toFixed(6)} VIN (ước tính)`;
}

$buyQty?.addEventListener("input", ()=> updateBuyTotal());

async function onSubmitBuy(){
  try{
    if(!currentBuy) return;
    if(!priceCache.vinPerVND_wei) await fetchVinVND();
    const qty = Number($buyQty.value||"1");
    if(qty<=0) return toast("Số lượng phải > 0","warn");

    // Simple “encoding” to avoid plain-text (NOT strong encryption)
    const infoObj = {
      name: $buyName.value||"",
      address: $buyAddress.value||"",
      phone: $buyPhone.value||"",
      note: $buyNote.value||""
    };
    const infoCipher = toHex(JSON.stringify(infoObj));

    // Compute vinAmount ≈ ceil(totalVND * vinPerVND)
    const vinPerVND = priceCache.vinPerVND_wei;               // wei per 1 VND
    const totalVND  = BigInt(currentBuy.priceVND) * BigInt(qty);
    const vinAmount = ethers.BigNumber.from(totalVND.toString()).mul(vinPerVND.toString()); // ceil done in contract

    // Approve & placeOrder
    await ensureAllowance(MUABAN_ADDR, vinAmount);
    const tx = await muaban.placeOrder(
      currentBuy.pid,
      qty,
      vinPerVND.toString(),
      infoCipher
    );
    toast("Đang gửi giao dịch mua…"); await tx.wait();
    toast("Đặt hàng thành công! VIN đã được ký quỹ trong hợp đồng.");
    closeModal();
    await refreshBalancesAndState();
  }catch(e){
    console.error(e);
    toast("Không thể mua sản phẩm. Vui lòng kiểm tra ví, mạng & số dư.", "error");
  }
}

/* -------------------- 9) Update modal open -------------------- */
async function onClickOpenUpdate(e){
  const card = e.target.closest(".product-card");
  if(!card) return;
  const pid = Number(card.dataset.pid);
  try{
    const p = await muaban.getProduct(pid);
    if(String(p.seller).toLowerCase() !== account.toLowerCase()){
      toast("Bạn không phải người bán của sản phẩm này.","warn");
      return;
    }
    $updatePid.value   = pid;
    $updatePrice.value = String(p.priceVND||"");
    $updateDays.value  = String(p.deliveryDaysMax||"");
    $updateWallet.value= String(p.payoutWallet||"");
    $updateActive.checked = !!p.active;
    openModal($modalUpdate);
  }catch(err){
    console.error(err);
    toast("Không mở được form cập nhật.","error");
  }
}

/* -------------------- 10) Orders (placeholders) -------------------- */
/* Hợp đồng hiện không có API liệt kê order theo buyer/seller.
   Nếu cần, ta sẽ bổ sung chỉ mục off-chain. Ở đây hiển thị thông báo. */
function showOrders(section){
  if(section==="buy"){
    $ordersSellSection.classList.add("hidden");
    $ordersBuySection.classList.remove("hidden");
    $ordersBuyList.innerHTML = `<div class="order-card">Chức năng tra cứu đơn mua sẽ khả dụng khi có chỉ mục off-chain.</div>`;
  }else{
    $ordersBuySection.classList.add("hidden");
    $ordersSellSection.classList.remove("hidden");
    $ordersSellList.innerHTML = `<div class="order-card">Chức năng tra cứu đơn bán sẽ khả dụng khi có chỉ mục off-chain.</div>`;
  }
}

/* -------------------- 11) Wire UI events -------------------- */
$btnConnect?.addEventListener("click", connect);
$btnDisconnect?.addEventListener("click", disconnect);

$btnRegister?.addEventListener("click", onRegister);
$btnCreate?.addEventListener("click", ()=> { resetCreateForm(); openModal($modalCreate); });
$btnOrdersBuy?.addEventListener("click", ()=> showOrders("buy"));
$btnOrdersSell?.addEventListener("click", ()=> showOrders("sell"));

$btnSubmitCreate?.addEventListener("click", onSubmitCreate);
$btnSubmitUpdate?.addEventListener("click", onSubmitUpdate);
$btnSubmitBuy?.addEventListener("click", onSubmitBuy);

$$(".modal .close").forEach(btn=> btn.addEventListener("click", closeModal));
window.addEventListener("keydown", (e)=> { if(e.key==="Escape") closeModal(); });

$btnSearch?.addEventListener("click", ()=> renderProducts(productCache));
$searchInput?.addEventListener("keydown", (e)=> { if(e.key==="Enter") renderProducts(productCache); });

/* -------------------- 12) Boot -------------------- */
(async function boot(){
  fetchVinVND();                       // first paint
  setInterval(fetchVinVND, 60_000);    // refresh price each minute

  // Preload “public” list by scan (works ngay cả khi chưa kết nối ví)
  if(window.ethereum){
    // optional: not require connect to read-only provider
    const rpcProvider = new ethers.providers.JsonRpcProvider(VIC_RPC);
    muaban = new ethers.Contract(MUABAN_ADDR, MUABAN_ABI, rpcProvider);
    await loadProducts();
  }else{
    $productList.innerHTML = `<div class="product-card"><div></div><div class="product-info">Hãy cài MetaMask để trải nghiệm đầy đủ.</div></div>`;
  }
})();
