import {defineConfig,devices} from "@playwright/test";
export default defineConfig({
 testDir:"./test/browser",testMatch:"hosted-accounting.spec.ts",fullyParallel:false,workers:1,retries:0,reporter:"list",outputDir:"./test-results/accounting",
 use:{baseURL:"http://127.0.0.1:3014",serviceWorkers:"block",screenshot:"only-on-failure",...(process.env.CHROME_BIN?{launchOptions:{executablePath:process.env.CHROME_BIN}}:{})},
 projects:[{name:"desktop",use:{...devices["Desktop Chrome"],viewport:{width:1512,height:900}}},{name:"mobile",use:{...devices["Pixel 5"]}}],
 webServer:{command:"npm run dev -- --port 3014",env:{NEXT_DIST_DIR:".next-accounting-test",HOSTED_AGENTS_URL:"",HOSTED_FRONTEND_ORIGIN:""},url:"http://127.0.0.1:3014",reuseExistingServer:false,timeout:120000}
});
