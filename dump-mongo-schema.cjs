const { execSync } = require("child_process");
const fs = require("fs");

const uri = "mongodb://root:pAssW0rd123@64.225.124.70:27017";

const collections = [
"ebp_pomanager.po_management"
];

if (!fs.existsSync("./schemas")) {
    fs.mkdirSync("./schemas");
}

collections.forEach((ns) => {
    console.log(`Analyzing ${ns}...`);

    try {
        const output = execSync(
      `mongodb-schema "${uri}" ${ns} --format json --number 200  --no-values`,
      { encoding: "utf8", maxBuffer: 1024 * 1024 * 50 } // 50MB buffer
    );
        const filename = ns.replace(".", "_") + ".json";

        fs.writeFileSync(`./schemas/${filename}`, output);

        console.log(`Saved -> schemas/${filename}`);
    } catch (err) {
        console.error(`Failed -> `, err);
    }
});

console.log("Schema extraction completed.");