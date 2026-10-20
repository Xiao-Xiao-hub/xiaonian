/*
 * 资料复习共用动作：提供加入、移出复习及页面提示，供学习页复用。
 * 请求作用于指定资料；地图复习由 learn 接口管理，不能混用两种进度。
 */
const api = require("./api");
const { dueText, errorText } = require("./format");
// Page methods for the "过几天回头看看" control; the page keeps the material `id` in data.
module.exports = {
  setReview(review) {
    this.setData({
      review,
      reviewText: review ? `${dueText(review.dueOn)}再提醒你看` : "",
    });
  },
  addReview() {
    api
      .post(`/v1/materials/${this.data.id}/review`)
      .then((review) => {
        this.setReview(review);
        wx.showToast({ title: `好，${dueText(review.dueOn)}再提醒你看`, icon: "none" });
      })
      .catch((error) => this.setData({ error: errorText(error) }));
  },
  removeReview() {
    api
      .del(`/v1/materials/${this.data.id}/review`)
      .then(() => this.setReview(null))
      .catch((error) => this.setData({ error: errorText(error) }));
  },
};
