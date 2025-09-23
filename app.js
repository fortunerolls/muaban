
/* ======================= Muaban.vin - app.js (full rewrite) =======================
 * Network: Viction Mainnet (chainId 88)
 * Explorer: https://vicscan.xyz
 * RPC:     https://rpc.viction.xyz
 * Notes:
 *  - Force legacy (type:0) tx + gasPrice for VIC to avoid EIP-1559 issues.
 *  - Always pre-simulate (eth_call) populated tx to expose revert reasons.
 *  - placeOrder requires "vinPerVND" (VIN wei per 1 VND). We compute from
 *    Binance VICUSDT * 100 (VIN=100*VIC) * USDT/VND (CoinGecko).
 *  - Strictly match index.html IDs.
 * ================================================================================ */
(function() { 'use strict';

// --------------------------- DOM helpers ---------------------------
const $  = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function shortAddr(a){ return a ? a.slice(0,6)+'…'+a.slice(-4) : ''; }

function toast(msg){
  // Simple toast via alert; can be replaced by nicer UI if needed.
  try{ console.log('[toast]', msg); }catch{}
  alert(msg);
}

// --------------------------- Constants -----------------------------
const VIC = {
  chainIdDec: 88,
  chainIdHex: '0x58',
  rpcUrls: ['https://rpc.viction.xyz'],
  explorer: 'https://vicscan.xyz',
  name: 'Viction Mainnet',
  native: { name:'VIC', symbol:'VIC', decimals:18 }
};

const CONTRACTS = { 
  MUABAN: '0x190FD18820498872354eED9C4C080cB365Cd12E0',
  VIN:    '0x941F63807401efCE8afe3C9d88d368bAA287Fac4'
};

const GAS = {
  // User asked to set high. Adjust if needed.
  gasPriceGwei: '50',
  light:  250_000,
  med:    600_000,
  heavy:  1_000_000
};

// ABIs will be fetched lazily
let MUABAN_ABI = null;
let VIN_ABI    = null;

// ----------------------- Provider / Wallet -------------------------
function getEthereum(){
  const eth = window.ethereum;
  if (!eth) return null;
  if (Array.isArray(eth.providers)){
    const mm = eth.providers.find(p => p.isMetaMask);
    return mm || eth.providers[0];
  }
  return eth;
}

function normChainId(chainId){
  if (typeof chainId === 'string'){
    const hex = chainId.toLowerCase();
    return { dec: parseInt(hex, 16), hex };
  } else if (typeof chainId === 'number'){
    return { dec: chainId, hex: '0x' + chainId.toString(16) };
  }
  return { dec: NaN, hex: '' };
}

async function ensureVIC(eth){
  const { dec } = normChainId(await eth.request({ method: 'eth_chainId' }));
  if (dec === VIC.chainIdDec) return true;
  try{
    await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: VIC.chainIdHex }] });
    return true;
  }catch(err){
    if (err && (err.code === 4902 || String(err.message||'').includes('Unrecognized chain ID'))){
      await eth.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: VIC.chainIdHex,
          chainName: VIC.name,
          nativeCurrency: VIC.native,
          rpcUrls: VIC.rpcUrls,
          blockExplorerUrls: [VIC.explorer]
        }]
      });
      return true;
    }
    throw err;
  }
}

let provider, signer, account, muaban, vin;

function legacyOverrides(weight='light'){
  const gas = weight==='heavy'?GAS.heavy: weight==='med'?GAS.med:GAS.light;
  return {
    type: 0,
    gasPrice: ethers.utils.parseUnits(GAS.gasPriceGwei, 'gwei'),
    gasLimit: ethers.BigNumber.from(String(gas))
  };
}

async function loadABIs(){
  if (!MUABAN_ABI) MUABAN_ABI = await fetch('Muaban_ABI.json', {cache:'no-store'}).then(r=>r.json());
  if (!VIN_ABI)    VIN_ABI    = await fetch('VinToken_ABI.json', {cache:'no-store'}).then(r=>r.json());
}

async function initContracts(){
  await loadABIs();
  muaban = new ethers.Contract(CONTRACTS.MUABAN, MUABAN_ABI, signer || provider);
  vin    = new ethers.Contract(CONTRACTS.VIN,    VIN_ABI,    signer || provider);
}

async function connectWallet(){
  const eth = getEthereum();
  if (!eth){ toast('Không tìm thấy ví (MetaMask).'); return; }
  await ensureVIC(eth);

  provider = new ethers.providers.Web3Provider(eth, 'any');
  const accs = await eth.request({ method: 'eth_requestAccounts' });
  account = accs && accs[0] || null;
  signer  = provider.getSigner();

  const { dec } = normChainId(await eth.request({ method:'eth_chainId' }));
  if (dec !== VIC.chainIdDec){
    await ensureVIC(eth);
  }

  // listeners
  eth.removeAllListeners && eth.removeAllListeners('chainChanged');
  eth.removeAllListeners && eth.removeAllListeners('accountsChanged');

  eth.on('chainChanged', async (hex)=>{
    const { dec } = normChainId(hex);
    if (dec !== VIC.chainIdDec){
      try{ await ensureVIC(eth); }catch(e){ console.warn('switch back fail', e); }
    }
    provider = new ethers.providers.Web3Provider(eth, 'any');
    signer   = provider.getSigner();
    await afterWalletReady();
  });

  eth.on('accountsChanged', async (accs)=>{
    account = (accs && accs[0]) || null;
    signer  = provider.getSigner();
    await afterWalletReady();
  });

  await afterWalletReady();
}

// ----------------------- Price Feed (VIN/VND) -----------------------
// 1 VIN = 100 * VIC. We fetch VICUSDT from Binance, USDT/VND from CoinGecko.
let lastPrice = { vic_usdt: 0, usdt_vnd: 0, vin_vnd: 0, vin_per_vnd_wei: ethers.constants.Zero };

async function fetchPrices(){
  try{
    const [vicRes, usdRes] = await Promise.all([
      fetch('https://api.binance.com/api/v3/ticker/price?symbol=VICUSDT', {cache:'no-store'}),
      fetch('https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=vnd', {cache:'no-store'})
    ]);
    const vicJson = await vicRes.json();
    const usdJson = await usdRes.json();

    const vic_usdt = parseFloat(vicJson?.price || '0');               // USDT
    const usdt_vnd = parseFloat(usdJson?.tether?.vnd || '0');         // VND/USDT
    if (vic_usdt>0 && usdt_vnd>0){
      const vin_vnd = vic_usdt * 100 * usdt_vnd;                      // VND per 1 VIN
      // vinPerVND = 1e18 / vin_vnd
      const ONE = ethers.BigNumber.from('1000000000000000000');
      const vin_per_vnd_wei = ONE.div(Math.max(1, Math.floor(vin_vnd)));
      lastPrice = { vic_usdt, usdt_vnd, vin_vnd, vin_per_vnd_wei };
      const el = $('#vinPrice');
      if (el){
        el.textContent = '1 VIN ≈ ' + new Intl.NumberFormat('vi-VN').format(Math.round(vin_vnd)) + ' VND';
      }
    }
  }catch(e){
    console.warn('[price] fetch error', e);
  }
}

// -------------------- Revert reason parsing -------------------------
function parseRevert(data){
  try{
    if (!data || typeof data !== 'string') return null;
    // Error(string): 0x08c379a0
    if (data.startsWith('0x08c379a0')){
      const iface = new ethers.utils.Interface(['function Error(string)']);
      const reason = iface.decodeFunctionData('Error', data)[0];
      return String(reason);
    }
    // Panic(uint256): 0x4e487b71
    if (data.startsWith('0x4e487b71')){
      return 'Panic(' + ethers.BigNumber.from('0x'+data.slice(10)).toString() + ')';
    }
  }catch{}
  return null;
}

async function simulate(txReq){
  try{
    // Need from field for access control checks
    if (!txReq.from) txReq.from = account;
    await provider.call(txReq);
    return null; // no error
  }catch(e){
    const data = e?.data || e?.error?.data || e?.error?.message || '';
    const reason = typeof data === 'string' ? parseRevert(data) : null;
    return reason || 'SIMULATE_REVERT';
  }
}

// --------------------------- UI Binding -----------------------------
async function afterWalletReady(){
  await loadABIs();
  await initContracts();
  await refreshBalances();
  await refreshRegistered();
  await loadAllProducts();
  setupMenuVisibility();
}

async function refreshBalances(){
  if (!account || !provider) return;
  try{
    const [vicBal, vinBal] = await Promise.all([
      provider.getBalance(account),
      vin.balanceOf(account)
    ]);
    $('#vicBalance').textContent = 'VIC: ' + parseFloat(ethers.utils.formatEther(vicBal)).toFixed(4);
    $('#vinBalance').textContent = 'VIN: ' + Number(ethers.utils.formatUnits(vinBal, 18)).toFixed(4);
    const a = $('#accountShort');
    if (a){
      a.textContent = shortAddr(account);
      a.href = VIC.explorer + '/address/' + account;
    }
    $('#walletBox')?.classList.remove('hidden');
    $('#btnConnect')?.classList.add('hidden');
  }catch(e){
    console.warn('refreshBalances', e);
  }
}

async function refreshRegistered(){
  if (!account || !muaban) return;
  let reg = false;
  try{ reg = await muaban.registered(account); }catch{}
  // Toggle menu buttons
  if (reg){
    $('#btnRegister')?.classList.add('hidden');
    $('#btnCreate')?.classList.remove('hidden');
    $('#btnOrdersBuy')?.classList.remove('hidden');
    $('#btnOrdersSell')?.classList.remove('hidden');
  }else{
    $('#btnRegister')?.classList.remove('hidden');
    $('#btnCreate')?.classList.add('hidden');
    $('#btnOrdersBuy')?.classList.add('hidden');
    $('#btnOrdersSell')?.classList.add('hidden');
  }
  $('#menuBox')?.classList.remove('hidden');
}

// ---------------------------- Register ------------------------------
async function onRegister(){
  await loadABIs(); await initContracts();
  const fee = await muaban.REG_FEE(); // 0.001 VIN
  const allowance = await vin.allowance(account, CONTRACTS.MUABAN);
  if (allowance.lt(fee)){
    const tx1 = await vin.populateTransaction.approve(CONTRACTS.MUABAN, fee);
    tx1.from = account;
    const err = await simulate(tx1);
    if (err){ toast('Approve lỗi: ' + err); return; }
    await (await (vin.connect(signer)).approve(CONTRACTS.MUABAN, fee, legacyOverrides('med'))).wait();
  }
  const tx2 = await muaban.populateTransaction.payRegistration();
  tx2.from = account;
  const err2 = await simulate(tx2);
  if (err2){ toast('Đăng ký lỗi: ' + err2); return; }
  await (await (muaban.connect(signer)).payRegistration(legacyOverrides('med'))).wait();
  toast('Đăng ký thành công.');
  await refreshRegistered();
}

// -------------------------- Create Product --------------------------
function openCreate(){
  $('#formCreate')?.classList.remove('hidden');
}
function closeModals(){ $$('.modal').forEach(m=>m.classList.add('hidden')); }

async function onSubmitCreate(){
  await loadABIs(); await initContracts();
  try{
    const name  = ($('#createName').value||'').trim();
    const ipfs  = ($('#createIPFS').value||'').trim();
    const unit  = ($('#createUnit').value||'').trim();
    const price = Math.max(1, Number($('#createPrice').value||0));  // VND integer
    const wall  = ($('#createWallet').value||'').trim();
    const days  = Math.max(1, Number($('#createDays').value||0));   // uint32

    if (!name || !ipfs || !unit || !price || !wall || !days){
      toast('Vui lòng nhập đủ thông tin.'); return;
    }
    let payout;
    try{ payout = ethers.utils.getAddress(wall); }
    catch{ toast('Ví nhận thanh toán không hợp lệ.'); return; }

    const descriptionCID = 'unit:' + unit;
    const imageCID = ipfs;
    const priceBN  = ethers.BigNumber.from(String(price));

    // simulate
    const txPop = await muaban.populateTransaction.createProduct(
      name, descriptionCID, imageCID, priceBN, days, payout, true
    );
    txPop.from = account;
    const reason = await simulate(txPop);
    if (reason){ toast('Không thể đăng sản phẩm: ' + reason); return; }

    const tx = await (muaban.connect(signer)).createProduct(
      name, descriptionCID, imageCID, priceBN, days, payout, true,
      legacyOverrides('heavy')
    );
    await tx.wait();
    toast('Đăng sản phẩm thành công.');
    closeModals();
    await loadAllProducts(true);
  }catch(e){
    console.error('submitCreate', e);
    toast('Lỗi khi đăng sản phẩm.');
  }
}

// --------------------------- List Products --------------------------
let allProductIds = [];

async function loadAllProducts(force=false){
  if (!provider || !muaban) return;
  if (allProductIds.length && !force){
    await renderProducts(allProductIds);
    return;
  }
  try{
    // Get all ProductCreated events
    const iface = new ethers.utils.Interface(MUABAN_ABI);
    const filter = { address: CONTRACTS.MUABAN, topics: [ iface.getEventTopic('ProductCreated') ] };
    const logs = await provider.getLogs({ ...filter, fromBlock: 0, toBlock: 'latest' });
    const ids = new Set();
    for (const lg of logs){
      try{
        const parsed = iface.parseLog(lg);
        const pid = parsed.args.productId?.toString?.() || parsed.args[0]?.toString?.();
        if (pid) ids.add(pid);
      }catch{}
    }
    allProductIds = Array.from(ids).map(x=>Number(x)).sort((a,b)=>b-a);
    await renderProducts(allProductIds);
  }catch(e){
    console.warn('loadAllProducts', e);
  }
}

async function renderProducts(pids){
  const list = $('#productList');
  list.innerHTML = '';
  for (const pid of pids){
    try{
      const p = await muaban.getProduct(pid);
      const name = p.name;
      const priceVND = p.priceVND;
      const img = p.imageCID || '';
      const unit = (p.descriptionCID||'').startsWith('unit:') ? p.descriptionCID.slice(5) : p.descriptionCID;
      const active = p.active;
      const seller = p.seller;

      const card = document.createElement('div');
      card.className = 'product';
      card.innerHTML = `
        <img src="${'{'}img{'}'}" alt="product" onerror="this.style.display='none'"/>
        <div class="p-title">${'{'}name{'}'}</div>
        <div class="p-price">Giá: ${'{'}fmtVND(priceVND){'}'} / ${'{'}unit||'-'{'}'}</div>
        <div class="p-seller"><a class="mono" target="_blank" rel="noopener" href="${'{'}VIC.explorer{'}'}/address/${'{'}seller{'}'}">${'{'}shortAddr(String(seller)){'}'}</a></div>
        <div class="p-actions"></div>
      `;

      const actions = card.querySelector('.p-actions');
      const btnBuy = document.createElement('button');
      btnBuy.className = 'btn primary';
      btnBuy.textContent = 'Mua';
      btnBuy.onclick = ()=> openBuyModal(pid, name, priceVND, unit);

      actions.appendChild(btnBuy);

      if (account && String(account).toLowerCase() === String(seller).toLowerCase()){
        const btnEdit = document.createElement('button');
        btnEdit.className = 'btn';
        btnEdit.textContent = 'Sửa';
        btnEdit.onclick = ()=> openUpdateModal(pid, priceVND, p.deliveryDaysMax, p.payoutWallet, active);
        actions.appendChild(btnEdit);
      }

      list.appendChild(card);
    }catch(e){
      console.warn('renderProduct', pid, e);
    }
  }
}

function fmtVND(x){
  try{
    const n = ethers.BigNumber.isBigNumber(x) ? x.toString() : String(x);
    return new Intl.NumberFormat('vi-VN').format(Number(n));
  }catch{ return String(x); }
}

// --------------------------- Update Product -------------------------
function openUpdateModal(pid, price, days, wallet, active){
  $('#formUpdate')?.classList.remove('hidden');
  $('#updatePid').value = String(pid);
  $('#updatePrice').value = String(price);
  $('#updateDays').value = String(days);
  $('#updateWallet').value = wallet || '';
  $('#updateActive').checked = !!active;
}

async function onSubmitUpdate(){
  await loadABIs(); await initContracts();
  try{
    const pid = Number($('#updatePid').value||0);
    const price = Math.max(1, Number($('#updatePrice').value||0));
    const days = Math.max(1, Number($('#updateDays').value||0));
    let wall = ($('#updateWallet').value||'').trim();
    try{ wall = ethers.utils.getAddress(wall); }
    catch{ toast('Ví nhận thanh toán không hợp lệ.'); return; }
    const active = !!$('#updateActive').checked;

    const priceBN = ethers.BigNumber.from(String(price));
    const txPop = await muaban.populateTransaction.updateProduct(pid, priceBN, days, wall, active);
    txPop.from = account;
    const reason = await simulate(txPop);
    if (reason){ toast('Không thể cập nhật: ' + reason); return; }

    const tx = await (muaban.connect(signer)).updateProduct(pid, priceBN, days, wall, active, legacyOverrides('med'));
    await tx.wait();
    toast('Cập nhật xong.');
    closeModals();
    await loadAllProducts(true);
  }catch(e){
    console.error('submitUpdate', e);
    toast('Lỗi khi cập nhật sản phẩm.');
  }
}

// ------------------------------ Buy -------------------------------
let currentBuyPid = null;
let currentBuyPriceVND = null;
let currentBuyUnit = null;

function openBuyModal(pid, name, priceVND, unit){
  currentBuyPid = pid;
  currentBuyPriceVND = priceVND;
  currentBuyUnit = unit;
  $('#formBuy')?.classList.remove('hidden');
  $('#buyProductInfo').innerHTML = `<strong>${'{'}name{'}'}</strong> — Giá: ${'{'}fmtVND(priceVND){'}'} VND/${'{'}unit||'-'{'}'}`;
  $('#buyQty').value = '1';
  updateBuyTotal();
}

function updateBuyTotal(){
  const qty = Math.max(1, Number($('#buyQty').value||0));
  const totalVND = (Number(currentBuyPriceVND)||0) * qty;
  const vin_vnd = lastPrice.vin_vnd || 0;
  let vinTotal = 0;
  if (vin_vnd > 0) vinTotal = totalVND / vin_vnd;
  $('#buyTotalVIN').textContent = 'Tổng VIN cần trả: ' + (vinTotal ? vinTotal.toFixed(6) : '…');
}

async function onSubmitBuy(){
  await loadABIs(); await initContracts();
  try{
    const qty = Math.max(1, Number($('#buyQty').value||0));
    const buyerInfo = {
      name: ($('#buyName').value||'').trim(),
      address: ($('#buyAddress').value||'').trim(),
      phone: ($('#buyPhone').value||'').trim(),
      note:  ($('#buyNote').value||'').trim()
    };
    if (!buyerInfo.name || !buyerInfo.address || !buyerInfo.phone){
      toast('Vui lòng điền đủ Họ tên, Địa chỉ, SĐT.'); return;
    }

    if (!lastPrice.vin_per_vnd_wei || lastPrice.vin_per_vnd_wei.isZero()){
      await fetchPrices();
      if (lastPrice.vin_per_vnd_wei.isZero()){
        toast('Không lấy được giá VIN/VND.'); return;
      }
    }

    // Allowance check: need to escrow vinAmount = ceil(totalVND * vinPerVND)
    const totalVND = ethers.BigNumber.from(String(currentBuyPriceVND)).mul(qty);
    const vinAmountEst = totalVND.mul(lastPrice.vin_per_vnd_wei); // ceil handled in contract
    const allowance = await vin.allowance(account, CONTRACTS.MUABAN);
    if (allowance.lt(vinAmountEst)){
      const tx1 = await vin.populateTransaction.approve(CONTRACTS.MUABAN, vinAmountEst);
      tx1.from = account;
      const sim1 = await simulate(tx1);
      if (sim1){ toast('Approve lỗi: ' + sim1); return; }
      await (await (vin.connect(signer)).approve(CONTRACTS.MUABAN, vinAmountEst, legacyOverrides('med'))).wait();
    }

    const note = JSON.stringify(buyerInfo); // (có thể mã hóa ngoài chuỗi nếu muốn)
    const txPop = await muaban.populateTransaction.placeOrder(currentBuyPid, qty, lastPrice.vin_per_vnd_wei, note);
    txPop.from = account;
    const sim2 = await simulate(txPop);
    if (sim2){ toast('Không thể đặt hàng: ' + sim2); return; }

    const tx = await (muaban.connect(signer)).placeOrder(currentBuyPid, qty, lastPrice.vin_per_vnd_wei, note, legacyOverrides('heavy'));
    await tx.wait();
    toast('Đặt hàng thành công.');
    closeModals();
  }catch(e){
    console.error('submitBuy', e);
    toast('Lỗi khi đặt hàng.');
  }
}

// ------------------------- Orders (optional) ------------------------
// Minimal placeholders to avoid breaking UI; can be extended.
async function showOrdersBuy(){
  $('#ordersBuySection')?.classList.remove('hidden');
  $('#ordersSellSection')?.classList.add('hidden');
}
async function showOrdersSell(){
  $('#ordersSellSection')?.classList.remove('hidden');
  $('#ordersBuySection')?.classList.add('hidden');
}

// --------------------------- Search --------------------------------
function onSearch(){
  const kw = ($('#searchInput').value||'').trim().toLowerCase();
  if (!kw){
    $$('#productList .product').forEach(el=>el.style.display='');
    return;
  }
  $$('#productList .product').forEach(el=>{
    const title = (el.querySelector('.p-title')?.textContent||'').toLowerCase();
    el.style.display = title.includes(kw) ? '' : 'none';
  });
}

// -------------------------- Wiring UI -------------------------------
function bindUI(){
  $('#btnConnect')?.addEventListener('click', ()=>connectWallet().catch(err=>{ console.error(err); toast('Kết nối ví thất bại.'); }));
  $('#btnDisconnect')?.addEventListener('click', ()=>{ location.reload(); });
  $('#btnRegister')?.addEventListener('click', ()=>onRegister().catch(e=>{ console.error(e); toast('Đăng ký thất bại.'); }));
  $('#btnCreate')?.addEventListener('click', openCreate);
  $('#btnSubmitCreate')?.addEventListener('click', ()=>onSubmitCreate().catch(e=>{ console.error(e); }));
  $('#btnSubmitUpdate')?.addEventListener('click', ()=>onSubmitUpdate().catch(e=>{ console.error(e); }));
  $('#btnSubmitBuy')?.addEventListener('click', ()=>onSubmitBuy().catch(e=>{ console.error(e); }));
  $('#btnOrdersBuy')?.addEventListener('click', ()=>showOrdersBuy());
  $('#btnOrdersSell')?.addEventListener('click', ()=>showOrdersSell());
  $('#btnSearch')?.addEventListener('click', onSearch);
  $$('#formCreate .close, #formUpdate .close, #formBuy .close').forEach(el=> el.addEventListener('click', closeModals));
  $('#buyQty')?.addEventListener('input', updateBuyTotal);
}

function setupMenuVisibility(){ /* placeholder for any extra logic */ }

async function boot(){
  bindUI();
  await loadABIs();
  provider = new ethers.providers.JsonRpcProvider(VIC.rpcUrls[0]); // read-only provider
  await initContracts();
  await fetchPrices();
  setInterval(fetchPrices, 60_000);
  await loadAllProducts();
}

document.addEventListener('DOMContentLoaded', boot);

})();