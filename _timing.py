import sys, time, asyncio, httpx, bcrypt
sys.path.insert(0, ".")

BASE = "http://127.0.0.1:8000"

# 1) raw bcrypt at cost 10 and 12
for cost in (10, 12):
    h = bcrypt.hashpw(b"localpass123", bcrypt.gensalt(rounds=cost))
    t0 = time.perf_counter()
    for _ in range(5):
        bcrypt.checkpw(b"localpass123", h)
    t1 = time.perf_counter()
    print(f"bcrypt check cost={cost}: {(t1-t0)/5*1000:.0f} ms")

# 2) HTTP timings (same machine, python client)
async def time_req(label, method, url, **kw):
    t0 = time.perf_counter()
    async with httpx.AsyncClient() as c:
        r = await c.request(method, url, **kw)
    t1 = time.perf_counter()
    print(f"{label}: HTTP {r.status_code} in {(t1-t0)*1000:.0f} ms")
    return r

async def main():
    await time_req("GET /health      ", "GET", BASE + "/health")
    await time_req("POST /auth/login ", "POST", BASE + "/auth/login",
                   json={"username": "localuser", "password": "localpass123"})
    # 3 fresh requests to see warm behavior
    for i in range(3):
        await time_req(f"POST /auth/login #{i+1}", "POST", BASE + "/auth/login",
                       json={"username": "localuser", "password": "localpass123"})

asyncio.run(main())