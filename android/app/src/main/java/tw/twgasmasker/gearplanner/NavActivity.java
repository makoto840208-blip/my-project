package tw.twgasmasker.gearplanner;

/** 導航圖示：同一個 App、同一份資料，只是一開始就進導航頁。 */
public class NavActivity extends MainActivity {
    @Override
    protected String startPath() {
        return "nav.html";
    }
}
