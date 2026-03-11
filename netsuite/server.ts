import app from "./app";
import dotenv from "dotenv";
dotenv.config();

const PORT = 5002;
app.listen(PORT, () => {

    console.log(`🚀 Server running at http://localhost:${PORT}`);
});
